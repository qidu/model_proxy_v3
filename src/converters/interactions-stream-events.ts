/**
 * The `/v1/interactions` streaming dialect — the `InteractionSSEEvent` union of
 * `@google/genai`: `interaction.created`, `step.start`, `step.delta`,
 * `step.stop`, `interaction.completed` (the union also declares
 * `interaction.status_update`, which these egresses do not use, and `error` for diagnostics).
 *
 * The `/v1/interactions` streaming egresses write through this module, including
 * Gemini, Responses, Claude, and the legacy cross-mode transformer. They used to disagree: the Gemini path
 * followed `docs/api/interactions.md`, whose vocabulary the SDK no longer
 * declares (`interaction.start` / `content.start|delta|stop` /
 * `interaction.complete` against the SDK's `interaction.created` / `step.*` /
 * `interaction.completed`), and the cross-mode path emitted a whole *non-streaming*
 * Interaction object per delta with no `event_type` at all — so a client built on
 * the SDK could dispatch on neither. The bundled doc predates the SDK; the SDK is
 * what a generated client actually switches on.
 *
 * Three consequences of the dialect are worth stating, because each is easy to
 * get wrong:
 *
 *   - Lifecycle events and the REST Interaction resource both carry the answer
 *     as `steps`. A streamed answer accumulates `Step`s, closing each one as its
 *     deltas end.
 *   - A step is announced empty by `step.start` and its content is published only
 *     when it closes. A step object that deltas mutated in place would leak
 *     content into the `step.start` frame that preceded it, which is why the
 *     accumulation here is a string and the step is built at close.
 *   - `usage` has no frame of its own: the completed interaction carries it.
 *     The cross-mode egress used to compute it and then lose the only payload
 *     that held it (`processSSEBuffer` skipped a converted chunk whose only
 *     payload was the usage), so a streamed answer reported three zeros.
 *
 * Everything here is pure: the caller frames each returned event with matching
 * SSE `event:` and payload `event_type` fields. The state is per-answer and owned
 * by the caller, so concurrent streams cannot share it.
 */

/** The step a delta is still appending to. */
interface OpenStep {
  kind: 'model_output' | 'thought';
  /** The text the deltas have appended so far. */
  text: string;
  /** The signature a thought_signature delta attached to this thought. */
  signature?: string;
}

/**
 * The steps one answer has announced so far, and which of them is still open.
 * `steps` is the same array the closing interaction publishes, so a step is
 * built once and both the live event and the closing resource read it.
 */
export interface InteractionStreamState {
  readonly model: string;
  readonly requestId: string;
  /** The interaction id the answer adopts; the caller may set it from the upstream. */
  id: string;
  /** ISO 8601, the `created`/`updated` both lifecycle events carry. */
  created: string;
  /** The steps closed so far, in order. */
  steps: Array<Record<string, unknown>>;
  /** The step a delta would still append to, or null when none is open. */
  open: OpenStep | null;
  /** `interaction.created` has been written. */
  createdWritten: boolean;
  /** The terminal event has been written; nothing may follow it. */
  finished: boolean;
  /**
   * The upstream said the answer is over, while its usage may still be in flight:
   * a stream can report counts on a frame of its own after the finish reason, and
   * completing on the finish frame would then publish zeros. So the caller records
   * the end here and emits the terminal frames once the stream is drained.
   */
  ended: boolean;
  /** The upstream failed the answer; this takes precedence over incomplete and requires_action. */
  failed: boolean;
  /** The upstream stopped at a token limit; this takes precedence over requires_action. */
  incomplete: boolean;
  /** Diagnostics published on error events and the closing Interaction resource. */
  errors: Array<Record<string, unknown>>;
  /** The answer's token usage, as the terminal frames report it. */
  usage?: Record<string, unknown>;
}

/** Start the state one streamed Interactions answer needs. */
export function createInteractionStreamState(model: string, requestId: string): InteractionStreamState {
  return {
    model,
    requestId,
    id: `v1_${Date.now()}_${requestId}`,
    created: new Date().toISOString(),
    steps: [],
    open: null,
    createdWritten: false,
    finished: false,
    ended: false,
    failed: false,
    incomplete: false,
    errors: [],
  };
}

/**
 * Adopt the upstream's own id for the interaction, when it reported one.
 *
 * The non-streaming egress prefers the upstream's id over a minted one for the
 * same reason (`convertGenerateContentToInteraction`), and a streamed answer that
 * minted its own would name a different interaction from the one a client gets
 * back by fetching the id it was just given.
 */
export function interactionStreamAdoptId(state: InteractionStreamState, id: unknown): void {
  if (state.createdWritten) return;
  if (typeof id === 'string' && id !== '') state.id = id;
}

/** The partial interaction the two lifecycle events carry. */
function lifecycleInteraction(
  state: InteractionStreamState,
  status: string,
  usage?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: state.id,
    model: state.model,
    status,
    object: 'interaction',
    created: state.created,
    updated: new Date().toISOString(),
    steps: state.steps,
    ...(usage ? { usage } : {}),
    ...(state.errors.length > 0 ? { errors: state.errors } : {}),
  };
}

/**
 * `interaction.created`, once per answer. Always the first frame: a client reading
 * the stream learns the interaction's id and model here, before any delta.
 */
export function interactionStreamCreated(state: InteractionStreamState): Array<Record<string, unknown>> {
  if (state.createdWritten) return [];
  state.createdWritten = true;
  return [{
    event_type: 'interaction.created',
    interaction: lifecycleInteraction(state, 'in_progress'),
  }];
}

/** Close the open step, publishing the content its deltas accumulated. */
function closeStep(
  state: InteractionStreamState,
  events: Array<Record<string, unknown>>,
): void {
  const open = state.open;
  if (!open) return;
  const index = state.steps.length;
  state.steps.push(open.kind === 'thought'
    ? {
      type: 'thought',
      summary: open.text === '' ? [] : [{ type: 'text', text: open.text }],
      ...(open.signature ? { signature: open.signature } : {}),
    }
    : { type: 'model_output', content: [{ type: 'text', text: open.text }] });
  events.push({ event_type: 'step.stop', index });
  state.open = null;
}

export function interactionStreamCloseStep(state: InteractionStreamState): Array<Record<string, unknown>> {
  const events = interactionStreamCreated(state);
  closeStep(state, events);
  return events;
}

/**
 * Open the step a delta appends to: the open one when it is the same kind,
 * otherwise a new one — closing the previous step first, because a step's deltas
 * must not interleave with another's. `step.start` announces it empty; what the
 * deltas append is published when it closes.
 */
function openStep(
  state: InteractionStreamState,
  events: Array<Record<string, unknown>>,
  kind: 'model_output' | 'thought',
): void {
  if (state.open) {
    if (state.open.kind === kind) return;
    closeStep(state, events);
  }
  state.open = { kind, text: '' };
  events.push({
    event_type: 'step.start',
    index: state.steps.length,
    step: kind === 'thought'
      ? { type: 'thought', summary: [] }
      : { type: 'model_output', content: [] },
  });
}

/**
 * One text delta of the answer: a `model_output` step's content, which is the
 * `StepDeltaData` member the SDK reads as text.
 */
export function interactionStreamText(state: InteractionStreamState, text: string): Array<Record<string, unknown>> {
  if (text === '') return [];
  const events = interactionStreamCreated(state);
  openStep(state, events, 'model_output');
  state.open!.text += text;
  events.push({
    event_type: 'step.delta',
    index: state.steps.length,
    delta: { type: 'text', text },
  });
  return events;
}

/**
 * One reasoning delta: a `thought` step's summary. The SDK spells a step's
 * reasoning `summary[].text` and the delta `thought_summary`, so the deltas are
 * accumulated as text parts of that summary while each carries its own increment.
 */
export function interactionStreamReasoning(state: InteractionStreamState, text: string): Array<Record<string, unknown>> {
  if (text === '') return [];
  const events = interactionStreamCreated(state);
  openStep(state, events, 'thought');
  state.open!.text += text;
  events.push({
    event_type: 'step.delta',
    index: state.steps.length,
    delta: { type: 'thought_summary', content: { type: 'text', text } },
  });
  return events;
}

/** A thought's signature, including the normal signature-without-summary shape. */
export function interactionStreamThoughtSignature(
  state: InteractionStreamState,
  signature: string,
  newBlock = false,
): Array<Record<string, unknown>> {
  if (signature === '') return [];
  const events = interactionStreamCreated(state);
  if (newBlock) closeStep(state, events);
  openStep(state, events, 'thought');
  state.open!.signature = signature;
  events.push({
    event_type: 'step.delta',
    index: state.steps.length,
    delta: { type: 'thought_signature', signature },
  });
  return events;
}

/**
 * A step that arrives whole rather than as deltas — a function call, an image.
 * Announced in full by `step.start` and closed at once, the way the Gemini
 * transformer already handled a whole part.
 */
export function interactionStreamWholeStep(
  state: InteractionStreamState,
  step: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const events = interactionStreamCreated(state);
  closeStep(state, events);
  state.steps.push(step);
  const index = state.steps.length - 1;
  events.push({ event_type: 'step.start', index, step });
  events.push({ event_type: 'step.stop', index });
  return events;
}

/**
 * Record that the answer is over, and the usage it reported — from whichever
 * frame carried it, which for an SSE upstream may not be the frame that carried
 * the finish reason.
 */
export function interactionStreamEnded(state: InteractionStreamState, usage?: Record<string, unknown>): void {
  state.ended = true;
  if (usage) state.usage = usage;
}

/**
 * The terminal frames: the open step closes, and the interaction completes with
 * the steps it announced and the answer's usage.
 *
 * `interaction.created` is emitted first when the answer streamed no content at
 * all, so a client always reaches the terminal event through a `created`.
 */
export function interactionStreamFinish(
  state: InteractionStreamState,
  status: string,
): Array<Record<string, unknown>> {
  if (state.finished) return [];
  state.finished = true;
  const events = interactionStreamCreated(state);
  closeStep(state, events);
  events.push({
    event_type: 'interaction.completed',
    interaction: lifecycleInteraction(state, status, state.usage),
  });
  return events;
}

/**
 * A Chat Completions `usage` as an Interactions `Usage`. The cross-mode egress
 * converts every upstream family to Completions usage first, so this is the one
 * place a streamed answer's counts are named for the Interactions client.
 */
export function completionsUsageToInteractionUsage(usage: unknown): Record<string, number> | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const input = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined;
  const output = typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined;
  if (input === undefined && output === undefined) return undefined;
  const mapped: Record<string, number> = {
    total_input_tokens: input ?? 0,
    total_output_tokens: output ?? 0,
    total_tokens: typeof u.total_tokens === 'number' ? u.total_tokens : (input ?? 0) + (output ?? 0),
  };
  const cached = (u.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens;
  if (typeof cached === 'number') mapped.total_cached_tokens = cached;
  return mapped;
}

/**
 * The `status` a finished answer's interaction carries: failure and token-limit
 * truncation both take precedence over a call; otherwise a turn that asked for a
 * tool is waiting on it, and anything else is done.
 */
export function interactionStreamStatus(state: InteractionStreamState): string {
  if (state.failed) return 'failed';
  if (state.incomplete) return 'incomplete';
  return state.steps.some(step => step.type === 'function_call') ? 'requires_action' : 'completed';
}

/**
 * An `error` event, for an answer the upstream refused or cut short. The event
 * carries one diagnostic as `error`; the closing Interaction repeats all such
 * diagnostics in the resource's `errors` array.
 */
export function interactionStreamError(
  state: InteractionStreamState,
  error: Record<string, unknown>,
): Array<Record<string, unknown>> {
  state.errors.push(error);
  return [{ event_type: 'error', error }];
}

/**
 * A `Content` as the `Step` carried by both streamed and non-streaming
 * interactions. Text and media belong to a `model_output`; thoughts and tool
 * activity are steps of their own.
 */
export function interactionStepFromContent(content: Record<string, unknown>): Record<string, unknown> {
  if (content.type === 'thought') {
    const legacySummary = (content.summary as Record<string, unknown> | undefined)?.content;
    const summary = Array.isArray(content.summary)
      ? content.summary
      : legacySummary ? [legacySummary] : [];
    return {
      type: 'thought',
      summary,
      ...(content.signature !== undefined ? { signature: content.signature } : {}),
    };
  }
  if (!['text', 'image', 'audio', 'video', 'document'].includes(String(content.type))) {
    return { ...content };
  }
  return { type: 'model_output', content: [content] };
}
