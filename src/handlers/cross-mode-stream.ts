/**
 * The cross-mode SSE egress seam.
 *
 * Two upstream families are not Gemini-shaped, so their streams are rendered into
 * OpenAI Completions chunks first (`processAnthropicSSEBuffer`,
 * `processResponsesSSEBuffer`) and then handed to `processSSEBuffer`, which turns a
 * Completions chunk into whatever the client's endpoint expects — Gemini
 * generateContent, Gemini Interactions, or Claude Messages. `processSSEBuffer` is
 * also the egress for an `openai-completions` upstream, which is why it lives here
 * beside the two drivers rather than in `handlers/openai.ts`.
 *
 * The two drivers differ in how much of their event vocabulary they map.
 * `processAnthropicSSEBuffer` maps the Anthropic events inline (its stream is
 * already close to what the clients want). `processResponsesSSEBuffer` maps none
 * of them itself: a Responses stream has almost no field in common with the
 * Completions chunk the next stage reads, so it defers the whole vocabulary to
 * `responsesStreamEventToChatChunks` — the same converter the
 * `/v1/chat/completions` egress uses — and only adds the one thing that converter
 * leaves to its caller, the usage Gemini clients read off the terminal chunk.
 *
 * Every per-request buffer below is keyed by `requestId` because concurrent
 * streams interleave on the event loop across `await reader.read()` suspension
 * points.
 *
 * Moved out of `src/handlers/openai.ts`; no behavior change.
 */

import { logPipelineStage, logPipelineHeaders } from '../utils/logger.js';
import type { Logger } from '../types/shared.js';
import { convertOpenAIToClaudeResponse } from '../converters/openai-to-claude.js';
import { convertOpenAIToGeminiGenerateContent, clearGeminiToolSchemas, extractThinkContent, parseToolArguments } from '../converters/openai-to-gemini.js';
import {
  completionsUsageToInteractionUsage,
  createInteractionStreamState,
  interactionStreamAdoptId,
  interactionStreamEnded,
  interactionStreamFinish,
  interactionStreamReasoning,
  interactionStreamStatus,
  interactionStreamText,
  interactionStreamWholeStep,
  type InteractionStreamState,
} from '../converters/interactions-stream-events.js';
import {
  createResponsesChatStreamState,
  responsesStreamEventToChatChunks,
  type ResponsesChatStreamState,
} from '../converters/responses-to-completions.js';

function openAIChunk(text: string, model: string, usage?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `chatcmpl_${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    ...(usage ? { usage } : {}),
  };
}

// Per-request buffers for Anthropic SSE → Gemini conversion, keyed by requestId.
// Concurrent streaming requests (e.g. parallel sub-agent tool calls) interleave
// on the event loop across `await reader.read()` suspension points, so a single
// shared buffer would corrupt unrelated requests' tool-call args. Entries are
// removed on message_stop / stream completion (see cleanup call sites below).
interface AnthropicToolBuffer { id: string; name: string; args: string; }
let anthropicToolBuffers: Map<string, Map<number, AnthropicToolBuffer>> = new Map();
// Keyed by requestId -> block index -> accumulated thinking text.
let anthropicThinkingBuffers: Map<string, Map<number, string>> = new Map();

/** Remove all per-request SSE conversion state for a finished/aborted request. */
function clearAnthropicSSEState(requestId: string): void {
  anthropicToolBuffers.delete(requestId);
  anthropicThinkingBuffers.delete(requestId);
  clearGeminiSSEState(requestId);
}

/**
 * The usage an Anthropic SSE stream has reported so far, collected across the
 * events of one response. Owned by `handleCrossModeStreamingResponse` and passed
 * in, so it dies with the stream instead of living in a requestId-keyed map that
 * a stream which never reaches `message_stop` would leak.
 */
interface AnthropicUsageAccumulator {
  inputTokens?: number;
  cachedTokens?: number;
  cacheWrittenTokens?: number;
  outputTokens?: number;
}

/** Absorb one `usage` object (`message_start.message.usage` or `message_delta.usage`). */
function absorbAnthropicUsage(target: AnthropicUsageAccumulator, usage: Record<string, unknown> | undefined): void {
  if (!usage || typeof usage !== 'object') return;
  const read = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
  // Last value wins: `message_start` carries the input side (and a partial
  // `output_tokens`), `message_delta` the final output count.
  target.inputTokens = read(usage.input_tokens) ?? target.inputTokens;
  target.cachedTokens = read(usage.cache_read_input_tokens) ?? target.cachedTokens;
  target.cacheWrittenTokens = read(usage.cache_creation_input_tokens) ?? target.cacheWrittenTokens;
  target.outputTokens = read(usage.output_tokens) ?? target.outputTokens;
}

/**
 * The accumulator in the Completions usage shape the Gemini converters read
 * (`prompt_tokens` / `completion_tokens` / `total_tokens`), or `undefined` while
 * the upstream has reported nothing yet — so a chunk emitted before any usage
 * arrived still carries no `usageMetadata` claim it cannot make.
 *
 * The three Anthropic input fields are summed because the Messages API reports
 * `input_tokens` with both cache fields *excluded*, while Gemini's
 * `promptTokenCount` includes the cached portion (`dashboard-stats.ts` makes the
 * same point when it reads that field back).
 */
function anthropicUsageToCompletionUsage(usage: AnthropicUsageAccumulator): Record<string, number> | undefined {
  if (usage.inputTokens === undefined && usage.cachedTokens === undefined
    && usage.cacheWrittenTokens === undefined && usage.outputTokens === undefined) {
    return undefined;
  }
  const prompt = (usage.inputTokens ?? 0) + (usage.cachedTokens ?? 0) + (usage.cacheWrittenTokens ?? 0);
  const completion = usage.outputTokens ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

function processAnthropicSSEBuffer(
  buffer: string,
  model: string,
  requestId: string,
  isInteractionsRequest: boolean,
  isGenerateContentRequest: boolean,
  usageAccum: AnthropicUsageAccumulator,
): { processed: string; remaining: string } {
  let result = '';
  const events = buffer.split('\n\n');
  const remaining = events.pop() || '';

  let toolBuffers = anthropicToolBuffers.get(requestId);
  let thinkingBuffers = anthropicThinkingBuffers.get(requestId);

  for (const event of events) {
    if (!event.trim()) continue;
    const dataLine = event.split('\n').find(line => line.startsWith('data: '));
    if (!dataLine) continue;
    try {
      const parsed = JSON.parse(dataLine.slice(6));

      // One path for every place an Anthropic-shaped stream can carry answer
      // text, so each of them reports the usage collected so far (Gemini's
      // `usageMetadata` is a running total; the final chunk is authoritative).
      const emitText = (text: string): void => {
        if (text === '') return;
        const chunk = openAIChunk(text, model, anthropicUsageToCompletionUsage(usageAccum));
        const { processed } = processSSEBuffer(`data: ${JSON.stringify(chunk)}\n\n`, model, requestId, isInteractionsRequest, isGenerateContentRequest);
        result += processed;
      };

      if (parsed.type === 'message_start') {
        // Some Anthropic-compatible gateways replay the finished message inside
        // `message_start` (a non-streaming body dressed as a stream) and follow
        // it with `message_delta`. Standard Anthropic sends `content: []` here,
        // so this loop is a no-op for it. Text only: a `tool_use` block replayed
        // this way is still not converted — the tool path needs the
        // content_block_* events that feed `toolBuffers`.
        const message = parsed.message as Record<string, unknown> | undefined;
        absorbAnthropicUsage(usageAccum, message?.usage as Record<string, unknown> | undefined);
        const blocks = message?.content;
        if (Array.isArray(blocks)) {
          for (const block of blocks as Array<Record<string, unknown>>) {
            if (block?.type === 'text' && typeof block.text === 'string') emitText(block.text);
          }
        }
      } else if (parsed.type === 'content_block_start') {
        const block = parsed.content_block as Record<string, unknown> | undefined;
        if (block?.type === 'tool_use') {
          // Standard Anthropic sends input:{} here and streams args via input_json_delta.
          // Some compatible APIs (e.g. MiniMax) send args fully populated in input already.
          const input = block.input as Record<string, unknown> | undefined;
          const initialArgs = (input && Object.keys(input).length > 0) ? JSON.stringify(input) : '';
          if (!toolBuffers) { toolBuffers = new Map(); anthropicToolBuffers.set(requestId, toolBuffers); }
          toolBuffers.set(parsed.index as number, {
            id: (block.id as string) || '',
            name: (block.name as string) || '',
            args: initialArgs,
          });
        } else if (block?.type === 'thinking') {
          if (!thinkingBuffers) { thinkingBuffers = new Map(); anthropicThinkingBuffers.set(requestId, thinkingBuffers); }
          // Seeded from the block for the same reason as `input` above: a gateway
          // that fills the block up front sends no thinking_delta to follow.
          // Standard Anthropic sends `thinking: ''`, which is the previous value.
          thinkingBuffers.set(parsed.index as number, typeof block.thinking === 'string' ? block.thinking : '');
        } else if (block?.type === 'text' && typeof block.text === 'string') {
          // A pre-filled text block — the same gateway behavior, for text. No
          // text_delta follows it, so emitting nothing here loses the answer.
          emitText(block.text);
        }
      } else if (parsed.type === 'content_block_delta') {
        const delta = parsed.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'thinking_delta') {
          const existing = thinkingBuffers?.get(parsed.index as number);
          if (thinkingBuffers && existing !== undefined) {
            thinkingBuffers.set(parsed.index as number, existing + ((delta.thinking as string) || ''));
          }
        } else if (delta?.type === 'input_json_delta') {
          const tool = toolBuffers?.get(parsed.index as number);
          if (tool) tool.args += (delta.partial_json as string) || '';
        } else if (typeof delta?.text === 'string') {
          // Keyed on the payload rather than `delta.type === 'text_delta'`:
          // `text` is the field the text-bearing deltas use, and gateways spell
          // the type `text`, or omit it, as well as the documented `text_delta`.
          // A `signature_delta` carries `signature` and no `text`, so it stays
          // out of this branch.
          emitText(delta.text);
        }
      } else if (parsed.type === 'content_block_stop') {
        const blockIndex = parsed.index as number;
        const tool = toolBuffers?.get(blockIndex);
        if (tool) {
          toolBuffers!.delete(blockIndex);
          // Emit a complete OpenAI-format tool_calls chunk, then convert to the target format.
          // Use the Anthropic content-block index (not a hardcoded 0) so multiple
          // parallel tool calls in one turn don't collide in geminiToolCallBuffer —
          // colliding indices concatenate different tools' argument JSON into one
          // string, producing invalid_args errors for the merged/clobbered call.
          const toolUsage = anthropicUsageToCompletionUsage(usageAccum);
          const chunk = {
            id: `chatcmpl_${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{ index: blockIndex, id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.args } }],
              },
              finish_reason: null,
            }],
            ...(toolUsage ? { usage: toolUsage } : {}),
          };
          const { processed } = processSSEBuffer(`data: ${JSON.stringify(chunk)}\n\n`, model, requestId, isInteractionsRequest, isGenerateContentRequest);
          result += processed;
        } else if (thinkingBuffers?.has(parsed.index as number)) {
          // Emit the completed thinking block as a <think>…</think>-wrapped text so
          // processSSEBuffer's existing logic strips it into reasoning/cleanText.
          const thinking = thinkingBuffers.get(parsed.index as number) || '';
          thinkingBuffers.delete(parsed.index as number);
          if (thinking) emitText(`<think>${thinking}</think>`);
        }
      } else if (parsed.type === 'message_delta') {
        const delta = parsed.delta as Record<string, unknown> | undefined;
        const stopReason = delta?.stop_reason as string | undefined;
        const finishReason = stopReason === 'tool_use' ? 'tool_calls'
          : stopReason === 'max_tokens' ? 'length' : 'stop';
        // The turn's final usage rides on this event; absorbing it before the
        // finish chunk is built is what puts real counts in that chunk's
        // `usageMetadata` instead of the three zeros it used to carry.
        absorbAnthropicUsage(usageAccum, parsed.usage as Record<string, unknown> | undefined);
        const finishUsage = anthropicUsageToCompletionUsage(usageAccum);
        // Route through processSSEBuffer so its geminiToolCallBuffer flush logic fires.
        // Without this, tool calls buffered during content_block_stop are never emitted.
        const syntheticFinish = {
          id: `chatcmpl_${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          ...(finishUsage ? { usage: finishUsage } : {}),
        };
        const { processed } = processSSEBuffer(`data: ${JSON.stringify(syntheticFinish)}\n\n`, model, requestId, isInteractionsRequest, isGenerateContentRequest);
        result += processed;
      } else if (parsed.type === 'message_stop') {
        clearAnthropicSSEState(requestId);
        // Gemini generateContent/interactions streams end naturally; no sentinel needed.
      }
    } catch {
      // Skip invalid SSE data.
    }
  }

  return { processed: result, remaining };
}

/**
 * Render a Responses SSE stream into the Completions chunks `processSSEBuffer`
 * expects, then let it produce the client's endpoint format.
 *
 * Every event is mapped by `responsesStreamEventToChatChunks`, which is what the
 * `/v1/chat/completions` egress uses for this upstream family. This driver used
 * to hand-map `response.output_text.delta` and nothing else, so a Gemini client
 * on this route received text deltas and then a plain end of stream: no
 * `finishReason` (it lives on `response.completed` / `response.incomplete`, which
 * were dropped), no `functionCall` parts (`output_item.added`,
 * `function_call_arguments.delta` dropped), no thought parts (both reasoning
 * deltas dropped), and `usageMetadata` of three zeros on every frame.
 *
 * `state` carries the cross-event facts the converter needs and is owned by
 * `handleCrossModeStreamingResponse`, for the same reason as `usageAccum` there:
 * a stream that never reaches its terminal event must not leave its state behind
 * in a requestId-keyed map.
 *
 * Three failures are thrown rather than skipped — an unparseable frame, an
 * upstream `response.failed`, and (at the caller) a stream that ends before its
 * terminal event. All three would otherwise reach the client as a short but
 * apparently complete answer (rule #8). The caller aborts the client stream.
 */
function processResponsesSSEBuffer(
  buffer: string,
  model: string,
  requestId: string,
  isInteractionsRequest: boolean,
  isGenerateContentRequest: boolean,
  state: ResponsesChatStreamState,
): { processed: string; remaining: string } {
  // The terminal event already ended the answer: whatever is still buffered came
  // after it, and converting it would either repeat the ending or — for a partial
  // frame left in the tail flush — throw and abort a stream that has already told
  // the client it is complete.
  if (state.finished) return { processed: '', remaining: '' };

  let result = '';
  const events = buffer.split('\n\n');
  const remaining = events.pop() || '';

  for (const event of events) {
    if (!event.trim()) continue;
    const dataLine = event.split('\n').find(line => line.startsWith('data: '));
    if (!dataLine) continue;
    const data = dataLine.slice(6).trim();
    if (data === '' || data === '[DONE]') continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      throw new Error(`Invalid JSON in Responses SSE data (request ${requestId})`);
    }
    if (parsed.type === 'response.failed') {
      throw new Error(`Responses stream failed (request ${requestId})`);
    }
    for (const chunk of responsesStreamEventToChatChunks(state, parsed)) {
      // The converter leaves the usage on its state (`handleChatCompletionsPassthrough`
      // sends it as a separate `include_usage` frame after the finish chunk).
      // Gemini carries `usageMetadata` on the candidate and this egress has no
      // separate usage frame, so the terminal chunk is the only place it can ride.
      // Every other chunk stays usage-free: `convertOpenAIToGeminiGenerateContent`
      // fills the three zero fields when the object is missing.
      const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
      if (choice && choice.finish_reason != null && state.usage) {
        chunk.usage = state.usage;
      }
      const { processed } = processSSEBuffer(`data: ${JSON.stringify(chunk)}\n\n`, model, requestId, isInteractionsRequest, isGenerateContentRequest);
      result += processed;
    }
    if (isInteractionsRequest && parsed.type === 'response.incomplete') {
      interactionStateFor(requestId, model).failed = true;
    }
    // Nothing may follow the terminal event on the client stream: a Gemini client
    // ends the answer on `finishReason`.
    if (state.finished) break;
  }

  return { processed: result, remaining };
}

export async function handleCrossModeStreamingResponse(
  response: Response,
  model: string,
  requestId: string,
  logger: Logger,
  isInteractionsRequest: boolean,
  isGenerateContentRequest: boolean,
  source: 'anthropic-messages' | 'openai-responses',
): Promise<Response> {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  // The usage reported so far, for the Anthropic source only.
  const usageAccum: AnthropicUsageAccumulator = {};
  // The Responses source's cross-event state: the id/created/model adopted from
  // `response.created`, the `output_index` → `tool_calls[].index` map, the usage
  // and the output-item drop counts. Owned here rather than in a requestId-keyed
  // map so it dies with the stream.
  const responsesState = createResponsesChatStreamState(model);
  // The client-facing endpoint this egress writes, for the drop report below.
  // Both callers of this function come from the Gemini front doors.
  const clientPath = isGenerateContentRequest ? ':generateContent' : '/v1/interactions';

  (async () => {
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const rawChunk = new TextDecoder().decode(value);
        buffer += rawChunk;
        logPipelineStage(logger, requestId, 'upstream-response', response.url || `(upstream SSE, ${source})`, rawChunk);
        const converted = source === 'anthropic-messages'
          ? processAnthropicSSEBuffer(buffer, model, requestId, isInteractionsRequest, isGenerateContentRequest, usageAccum)
          : processResponsesSSEBuffer(buffer, model, requestId, isInteractionsRequest, isGenerateContentRequest, responsesState);
        buffer = converted.remaining;
        if (converted.processed) {
          logPipelineStage(logger, requestId, 'outbound', 'stream', converted.processed);
          await writer.write(encoder.encode(converted.processed));
        }
      }
      if (buffer.trim()) {
        const converted = source === 'anthropic-messages'
          ? processAnthropicSSEBuffer(buffer + '\n\n', model, requestId, isInteractionsRequest, isGenerateContentRequest, usageAccum)
          : processResponsesSSEBuffer(buffer + '\n\n', model, requestId, isInteractionsRequest, isGenerateContentRequest, responsesState);
        if (converted.processed) {
          logPipelineStage(logger, requestId, 'outbound', 'stream (final)', converted.processed);
          await writer.write(encoder.encode(converted.processed));
        }
      }
      // A Responses stream that stops before its terminal event leaves a Gemini
      // client with no `finishReason` at all — the stream just ends, and strict
      // SDKs reject that ("stream ended without a finish reason"). Abort instead,
      // so the client sees a broken stream rather than a complete answer; the
      // other two Responses egresses refuse the same way.
      if (source === 'openai-responses' && !responsesState.finished) {
        throw new Error(`Responses stream ended before response.completed (request ${requestId})`);
      }
      // The Interactions dialect ends on `interaction.completed`, and it is written
      // here rather than per chunk so the answer's usage — which an upstream may
      // report on a frame after the finish reason — is what the terminal frames
      // carry. Throws instead of completing when no finish reason ever arrived,
      // so a truncated answer is not announced as a finished interaction.
      if (isInteractionsRequest) {
        const terminal = finishInteractionsStream(requestId);
        if (terminal) {
          logPipelineStage(logger, requestId, 'outbound', 'stream (terminal)', terminal);
          await writer.write(encoder.encode(terminal));
        }
      }
      if (source === 'openai-responses') {
        warnDroppedOutputItems(logger, requestId, clientPath, responsesState.dropped);
      }
      await writer.close();
    } catch (error) {
      logger.error(requestId, `Cross-mode streaming error: ${(error as Error).message}`);
      await writer.abort();
    } finally {
      // Prevent leaking per-request buffer entries if the stream errors out
      // before message_stop/[DONE] triggers the normal cleanup.
      if (source === 'anthropic-messages') clearAnthropicSSEState(requestId);
      if (isInteractionsRequest) clearGeminiSSEState(requestId);
    }
  })();

  const crossModeOutHeaders = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'x-request-id': requestId,
  };
  logPipelineHeaders(logger, requestId, 'outbound', 'stream', crossModeOutHeaders);
  return new Response(readable, { headers: crossModeOutHeaders });
}

// Per-request buffer for <think>/<thinking> tags that may straddle SSE events,
// keyed by requestId. Concurrent streams interleave on the event loop across
// `await reader.read()` suspension points, so a single shared string would
// corrupt unrelated requests' text. Cleared on [DONE] / stream completion.
let thinkStreamBuffers: Map<string, string> = new Map();

// Per-request accumulation of streaming OpenAI tool_calls for the Gemini output
// paths, keyed by requestId -> tool_call index. Upstreams like DeepSeek fragment
// a single tool call across chunks: the first chunk carries id+name+partial-args,
// continuation chunks carry only more argument text at the same index. Emitting
// a Gemini functionCall per fragment produces name-less "call_undefined" calls,
// so we buffer by index and flush one complete functionCall when finish_reason
// arrives. Keyed by requestId (not just index) for the same reason as
// thinkStreamBuffers above — concurrent requests must not share state.
interface GeminiToolCallAccum { id: string; name: string; args: string; }
let geminiToolCallBuffers: Map<string, Map<number, GeminiToolCallAccum>> = new Map();

// Per-request `/v1/interactions` SSE state, keyed by requestId for the same reason
// as the two maps above: the step a delta appends to must be this answer's.
let interactionStreamStates: Map<string, InteractionStreamState> = new Map();

/** The state one Interactions answer builds its events on, created on first use. */
function interactionStateFor(requestId: string, model: string): InteractionStreamState {
  let state = interactionStreamStates.get(requestId);
  if (!state) {
    state = createInteractionStreamState(model, requestId);
    interactionStreamStates.set(requestId, state);
  }
  return state;
}

/** Frame the events the shared Interactions stream module returns. */
function interactionFrames(events: Array<Record<string, unknown>>): string {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
}

/**
 * The `/v1/interactions` frames for one parsed Completions chunk.
 *
 * This dialect is the SDK's `InteractionSSEEvent`, so there is no converted
 * intermediate chunk to render and filter: the Completions chunk's own fields are
 * read into `step.*` events, and a chunk carrying none of them yields no frame.
 * The events are the same ones the Gemini upstream's transformer emits, through
 * the same module, so the two front doors speak one dialect.
 *
 * The terminal `interaction.completed` is not written here: an upstream may report
 * the answer's usage on a frame after the one carrying the finish reason, so the
 * terminal frames wait for the drain (`finishInteractionsStream`).
 */
function interactionsFramesForChunk(
  parsed: Record<string, any>,
  requestId: string,
  model: string,
  toolCallBuffer: Map<number, GeminiToolCallAccum> | undefined,
): string {
  const state = interactionStateFor(requestId, model);
  const choice = parsed?.choices?.[0];
  const delta = choice?.delta as Record<string, any> | undefined;
  // The Completions chunk carries the upstream's own id, so the interaction the
  // client streams is named the same as the one it can fetch back.
  interactionStreamAdoptId(state, parsed?.id);
  let events: Array<Record<string, unknown>> = [];

  // A `<think>…</think>` block in the text is reasoning, not answer text — the
  // split `convertOpenAIToGeminiInteractions` made, so a reasoning model's tags
  // reach the client as a `thought` step rather than inside `model_output`.
  if (typeof delta?.content === 'string' && delta.content !== '') {
    const { reasoning, cleanText } = extractThinkContent(delta.content);
    events = [...events, ...interactionStreamReasoning(state, reasoning), ...interactionStreamText(state, cleanText)];
  }
  if (typeof delta?.reasoning_content === 'string') {
    events = [...events, ...interactionStreamReasoning(state, delta.reasoning_content)];
  }

  // Fragmented tool calls are announced once, complete, on the frame that ends the
  // turn — the same deferral the Gemini paths make, for the same reason: a
  // fragment would announce a call with no name and no arguments.
  if (choice?.finish_reason) {
    for (const call of toolCallBuffer?.values() ?? []) {
      if (!call.name) continue;
      events = [...events, ...interactionStreamWholeStep(state, {
        type: 'function_call',
        id: call.id,
        name: call.name,
        arguments: parseToolArguments(call.args),
      })];
    }
    toolCallBuffer?.clear();
    geminiToolCallBuffers.delete(requestId);
    interactionStreamEnded(state);
  }

  // Recorded whenever it arrives, which is not always the frame that ended the
  // answer: the openai-completions upstreams that gate usage behind
  // `stream_options.include_usage` report it on a later, choice-less frame.
  const usage = completionsUsageToInteractionUsage(parsed?.usage);
  if (usage) interactionStreamEnded(state, usage);

  return interactionFrames(events);
}

/**
 * The terminal `/v1/interactions` frames, written once the upstream stream is
 * drained. '' when this request has no state (its frames were already written on
 * its `[DONE]`, or it is not an Interactions request at all).
 *
 * A stream that stops without a finish reason is refused rather than completed:
 * a truncated answer announced as `interaction.completed` is a silent success
 * (rule #8), and the caller's error path aborts the client stream.
 */
export function finishInteractionsStream(requestId: string): string {
  const state = interactionStreamStates.get(requestId);
  if (!state) return '';
  interactionStreamStates.delete(requestId);
  if (!state.ended) {
    throw new Error(`Interactions stream ended before a finish reason (request ${requestId})`);
  }
  return interactionFrames(interactionStreamFinish(state, interactionStreamStatus(state)));
}

/** Remove all per-request SSE conversion state for a finished/aborted request. */
export function clearGeminiSSEState(requestId: string): void {
    thinkStreamBuffers.delete(requestId);
    geminiToolCallBuffers.delete(requestId);
    interactionStreamStates.delete(requestId);
    clearGeminiToolSchemas(requestId);
}

/**
 * Process SSE buffer and extract complete events
 */
export function processSSEBuffer(buffer: string, modelId: string, requestId: string, isInteractionsRequest: boolean = false, isGenerateContentRequest: boolean = false): { processed: string; remaining: string } {
    let result = '';
    let remaining = buffer;
    
    // Split by double newline (SSE event separator)
    const events = buffer.split('\n\n');
    
    // Last element might be incomplete, keep it in buffer
    remaining = events.pop() || '';

    let toolCallBuffer = geminiToolCallBuffers.get(requestId);

    for (const event of events) {
        if (!event.trim()) continue;

        const lines = event.split('\n');
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                    toolCallBuffer = undefined;
                    // `[DONE]` is the end-of-stream marker of an OpenAI-shaped
                    // upstream. An Interactions client reads no such marker — its
                    // dialect ends on `interaction.completed` — so the terminal
                    // frames are written here, before the state is released. A
                    // stream that never reported a finish reason throws instead of
                    // completing: see `finishInteractionsStream`.
                    if (isInteractionsRequest) result += finishInteractionsStream(requestId);
                    clearGeminiSSEState(requestId);
                    if (!isGenerateContentRequest && !isInteractionsRequest) {
                        result += 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
                    }
                } else {
                    try {
                        const parsed = JSON.parse(data);

                        // Stitch cross-chunk think tags: prepend any partial thinkStreamBuffer to current content
                        const thinkBuffered = thinkStreamBuffers.get(requestId);
                        if (thinkBuffered && parsed?.choices?.[0]?.delta?.content) {
                            parsed.choices[0].delta.content = thinkBuffered + parsed.choices[0].delta.content;
                            thinkStreamBuffers.delete(requestId);
                        }

                        // For the Gemini output paths, accumulate fragmented streaming
                        // tool_calls across chunks and strip them from the delta so the
                        // stateless converter never emits a partial functionCall. Flush
                        // complete calls when finish_reason arrives (handled below).
                        if (isGenerateContentRequest || isInteractionsRequest) {
                            const deltaToolCalls = parsed?.choices?.[0]?.delta?.tool_calls;
                            if (Array.isArray(deltaToolCalls)) {
                                if (!toolCallBuffer) { toolCallBuffer = new Map(); geminiToolCallBuffers.set(requestId, toolCallBuffer); }
                                for (const tc of deltaToolCalls) {
                                    const idx = typeof tc.index === 'number' ? tc.index : 0;
                                    let acc = toolCallBuffer.get(idx);
                                    if (!acc) {
                                        acc = { id: '', name: '', args: '' };
                                        toolCallBuffer.set(idx, acc);
                                    }
                                    if (tc.id) acc.id = tc.id;
                                    if (tc.function?.name) acc.name = tc.function.name;
                                    if (typeof tc.function?.arguments === 'string') acc.args += tc.function.arguments;
                                }
                                // Remove tool_calls from this chunk; they are emitted on flush.
                                delete parsed.choices[0].delta.tool_calls;
                            }
                        }

                        // If the converter will not consume the buffer-tail (tag never
                        // closed), carry it forward. Before the dialect branch below, so
                        // every dialect keeps the tag out of its answer text.
                        const emittedContent: string | undefined = parsed?.choices?.[0]?.delta?.content;
                        if (emittedContent) {
                            const partialOpen = emittedContent.lastIndexOf('<');
                            if (partialOpen !== -1 && !emittedContent.slice(partialOpen).includes('>')) {
                                thinkStreamBuffers.set(requestId, emittedContent.slice(partialOpen));
                            }
                        }

                        // The Interactions dialect has no converted intermediate chunk
                        // to render and filter: the chunk's own fields become events.
                        if (isInteractionsRequest) {
                            const frames = interactionsFramesForChunk(parsed, requestId, modelId, toolCallBuffer);
                            if (frames) result += frames;
                            continue;
                        }

                        let convertedChunk: Record<string, any> | null = null;

                        if (isGenerateContentRequest) {
                            // Convert to Gemini generateContent format
                            convertedChunk = convertOpenAIToGeminiGenerateContent(parsed, modelId, requestId);
                        } else {
                            // Convert to Claude format
                            convertedChunk = convertOpenAIToClaudeResponse(parsed, modelId, requestId);
                        }

                        // Flush accumulated tool calls when the turn finishes, injecting
                        // them as complete functionCall parts into the converted chunk.
                        const finishReason = parsed?.choices?.[0]?.finish_reason;
                        if (isGenerateContentRequest && finishReason && toolCallBuffer && toolCallBuffer.size > 0) {
                            const accumulated = Array.from(toolCallBuffer.values()).filter(a => a.name);
                            toolCallBuffer.clear();
                            geminiToolCallBuffers.delete(requestId);
                            const synthetic = {
                                choices: [{
                                    index: 0,
                                    delta: {},
                                    message: {
                                        role: 'assistant',
                                        content: '',
                                        tool_calls: accumulated.map(a => ({
                                            id: a.id, type: 'function',
                                            function: { name: a.name, arguments: a.args },
                                        })),
                                    },
                                    finish_reason: finishReason,
                                }],
                            };
                            convertedChunk = convertOpenAIToGeminiGenerateContent(synthetic, modelId, requestId);
                        }

                        // Skip chunks with no endpoint-specific payload.
                        if (!convertedChunk || (!convertedChunk.candidates && !convertedChunk.content)) {
                            continue;
                        }

                        result += `data: ${JSON.stringify(convertedChunk)}\n\n`;
                    } catch {
                        // Skip invalid JSON
                    }
                }
            }
        }
    }
    
    return { processed: result, remaining };
}

/**
 * Report Responses output items the conversion had no Chat Completions position
 * for. Called on every Responses egress; a silent drop is forbidden (rule #8) —
 * an `image_generation_call` result or a `web_search_call` vanishes from the
 * client's answer, and the log is the only place that can say so.
 *
 * The wording names the Completions hop rather than the client's format, because
 * that hop is where the item is lost: the Gemini egress reports the same drop
 * through this function.
 */
export function warnDroppedOutputItems(
  logger: Logger,
  requestId: string,
  path: string,
  dropped: Record<string, number>,
): void {
  for (const [type, count] of Object.entries(dropped)) {
    logger.warn(requestId, `${path} openai-responses → chat.completion: dropped ${count} output item(s) of type '${type}' (no Chat Completions representation)`);
  }
}
