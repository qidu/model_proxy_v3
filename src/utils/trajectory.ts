import { closeSync, constants as fsConstants, openSync, writeSync } from 'fs';
import type { Logger } from './logger.js';

export const TRAJECTORY_LOG_FILE = './model_proxy_trajectory.jsonl';

type TrajectoryKind = 'messages' | 'chat-completions' | 'responses' | 'interactions' | 'generate-content';
type JsonObject = Record<string, any>;

export interface TrajectoryRequestContext {
  kind: TrajectoryKind;
  sessionId: string;
  requestId: string;
  sequence: number;
  requestMessages: unknown[];
  toolResults: unknown[];
}

export interface TrajectoryRecord {
  session_id: string;
  request_id: string;
  sequence: number;
  timestamp: string;
  type: 'action';
  request_messages: unknown[];
  reasoning: unknown[];
  tool_calls: unknown[];
  tool_results: unknown[];
  assistant_text: string;
  usage: Record<string, unknown>;
  status: string;
}

interface NormalizedResponse {
  reasoning: unknown[];
  toolCalls: unknown[];
  assistantText: string;
  usage: Record<string, unknown>;
  status?: string;
}

const sessionSequences = new Map<string, number>();
const MAX_TRACKED_SESSIONS = 10_000;
const TRAJECTORY_SESSION_HEADERS = [
  'x-agent-session-id',
  'x-session-id',
  'x-deepseek-harness-session-id',
  'x-opencode-session',
  'x-claude-code-session-id',
  'x-cursor-session-id',
  'x-hermes-session-id',
  'session-id',
  'session_id',
  'thread-id',
  'conversation_id',
] as const;

export function resolveTrajectorySessionId(headers: Headers): string | null {
  for (const name of TRAJECTORY_SESSION_HEADERS) {
    const value = headers.get(name)?.trim();
    if (value) return value;
  }
  return null;
}

function trajectoryKind(path: string): TrajectoryKind | undefined {
  if (path === '/v1/messages' || path.startsWith('/v1/messages?')) return 'messages';
  if (path === '/v1/chat/completions' || path.startsWith('/v1/chat/completions?')) return 'chat-completions';
  if (path === '/v1/responses' || path.startsWith('/v1/responses?')) return 'responses';
  if (path === '/v1/interactions' || path.startsWith('/v1/interactions?')) return 'interactions';
  if (/^\/v1(?:beta)?\/models\/[^:?]+:(?:stream)?[Gg]enerateContent$/.test(path)) return 'generate-content';
  return undefined;
}

function nextSequence(sessionId: string, suppliedByClient: boolean): number {
  if (!suppliedByClient) return 1;
  const sequence = (sessionSequences.get(sessionId) ?? 0) + 1;
  sessionSequences.delete(sessionId);
  sessionSequences.set(sessionId, sequence);
  if (sessionSequences.size > MAX_TRACKED_SESSIONS) {
    const oldest = sessionSequences.keys().next().value;
    if (oldest !== undefined) sessionSequences.delete(oldest);
  }
  return sequence;
}

function inputMessages(body: JsonObject, kind: TrajectoryKind): unknown[] {
  if (kind === 'messages' || kind === 'chat-completions') {
    return Array.isArray(body.messages) ? structuredClone(body.messages) : [];
  }
  if (kind === 'generate-content') {
    if (Array.isArray(body.contents)) return structuredClone(body.contents);
    return body.contents === undefined ? [] : structuredClone([body.contents]);
  }
  const input = body.input;
  if (Array.isArray(input)) return structuredClone(input);
  if (typeof input === 'string') return [{ type: 'message', role: 'user', content: input }];
  return input === undefined ? [] : structuredClone([input]);
}

function requestToolResults(messages: unknown[], kind: TrajectoryKind): unknown[] {
  const results: unknown[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const item = message as JsonObject;
    if (kind === 'chat-completions') {
      if (item.role === 'tool') results.push(structuredClone(item));
      continue;
    }
    if (kind === 'responses') {
      if (item.type === 'function_call_output') results.push(structuredClone(item));
      continue;
    }
    if (kind === 'interactions') {
      if (item.type === 'function_result' || item.type === 'code_execution_result') {
        results.push(structuredClone(item));
      }
    }
    const content = Array.isArray(item.content) ? item.content
      : Array.isArray(item.parts) ? item.parts
        : Array.isArray(item.contents) ? item.contents : [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const value = block as JsonObject;
      if (value.type === 'tool_result' || value.type === 'function_result' || value.type === 'code_execution_result'
        || value.functionResponse !== undefined) {
        results.push(structuredClone(value));
      }
    }
  }
  return results;
}

export function createTrajectoryRequest(
  path: string,
  requestId: string,
  agentSessionHeader: string | null,
  body: JsonObject,
): TrajectoryRequestContext | undefined {
  const kind = trajectoryKind(path);
  if (!kind) return undefined;
  const suppliedSessionId = agentSessionHeader?.trim();
  const sessionId = suppliedSessionId || requestId;
  const requestMessages = inputMessages(body, kind);
  return {
    kind,
    sessionId,
    requestId,
    sequence: nextSequence(sessionId, !!suppliedSessionId),
    requestMessages,
    toolResults: requestToolResults(requestMessages, kind),
  };
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (typeof part === 'string') text += part;
    else if (part && typeof part === 'object' && typeof (part as JsonObject).text === 'string') {
      text += (part as JsonObject).text;
    }
  }
  return text;
}

function addInteractionContent(content: unknown[], normalized: NormalizedResponse): void {
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const item = block as JsonObject;
    if (item.type === 'text' && typeof item.text === 'string') normalized.assistantText += item.text;
    else if (item.type === 'thought') normalized.reasoning.push(structuredClone(item));
    else if (item.type === 'function_call' || item.type === 'code_execution_call') {
      normalized.toolCalls.push(structuredClone(item));
    }
  }
}

function normalizeJsonResponse(kind: TrajectoryKind, payload: JsonObject): NormalizedResponse {
  const normalized: NormalizedResponse = {
    reasoning: [], toolCalls: [], assistantText: '', usage: payload.usage ?? payload.usageMetadata ?? {},
  };

  if (kind === 'messages') {
    for (const block of Array.isArray(payload.content) ? payload.content : []) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') normalized.assistantText += contentText(block.text);
      else if (block.type === 'thinking' || block.type === 'redacted_thinking') normalized.reasoning.push(structuredClone(block));
      else if (block.type === 'tool_use') normalized.toolCalls.push(structuredClone(block));
    }
  } else if (kind === 'chat-completions') {
    for (const choice of Array.isArray(payload.choices) ? payload.choices : []) {
      const message = choice?.message ?? {};
      normalized.assistantText += contentText(message.content);
      const reasoning = message.reasoning_content ?? message.reasoning;
      if (reasoning !== undefined && reasoning !== null && reasoning !== '') {
        normalized.reasoning.push(typeof reasoning === 'string'
          ? { type: 'reasoning', reasoning_content: reasoning }
          : structuredClone(reasoning));
      }
      if (Array.isArray(message.tool_calls)) normalized.toolCalls.push(...structuredClone(message.tool_calls));
    }
  } else if (kind === 'responses') {
    normalized.status = payload.status;
    for (const item of Array.isArray(payload.output) ? payload.output : []) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'message') normalized.assistantText += contentText(item.content);
      else if (item.type === 'reasoning') normalized.reasoning.push(structuredClone(item));
      else if (typeof item.type === 'string' && item.type.endsWith('_call')) normalized.toolCalls.push(structuredClone(item));
    }
  } else if (kind === 'generate-content') {
    for (const candidate of Array.isArray(payload.candidates) ? payload.candidates : []) {
      for (const part of Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []) {
        if (!part || typeof part !== 'object') continue;
        if (part.thought === true || part.thoughtSignature !== undefined) normalized.reasoning.push(structuredClone(part));
        else if (part.functionCall) normalized.toolCalls.push(structuredClone(part));
        else if (typeof part.text === 'string') normalized.assistantText += part.text;
      }
    }
  } else if (kind === 'interactions') {
    normalized.status = payload.status;
    for (const step of Array.isArray(payload.steps) ? payload.steps : []) {
      if (!step || typeof step !== 'object') continue;
      if (step.type === 'thought') normalized.reasoning.push(structuredClone(step));
      else if (typeof step.type === 'string' && step.type.endsWith('_call')) normalized.toolCalls.push(structuredClone(step));
      else if (step.type === 'model_output' && Array.isArray(step.content)) addInteractionContent(step.content, normalized);
    }
    if (Array.isArray(payload.outputs)) addInteractionContent(payload.outputs, normalized);
  }
  return normalized;
}

class ResponseAccumulator {
  private finalPayload: JsonObject | undefined;
  private assistantText = '';
  private reasoning: unknown[] = [];
  private toolCalls: unknown[] = [];
  private usage: Record<string, unknown> = {};
  private status: string | undefined;
  private readonly claudeReasoning = new Map<number, JsonObject>();
  private readonly claudeTools = new Map<number, JsonObject>();
  private readonly claudeToolJson = new Map<number, string>();
  private readonly chatReasoning = new Map<number, string>();
  private readonly chatTools = new Map<string, JsonObject>();
  private readonly responseItems = new Map<string, JsonObject>();

  constructor(private readonly kind: TrajectoryKind) {}

  accept(payload: JsonObject): void {
    if (this.kind === 'messages') this.acceptMessages(payload);
    else if (this.kind === 'chat-completions') this.acceptChat(payload);
    else if (this.kind === 'responses') this.acceptResponses(payload);
    else if (this.kind === 'generate-content') this.acceptGemini(payload);
    else this.acceptInteraction(payload);
  }

  result(): NormalizedResponse {
    if (this.finalPayload) return normalizeJsonResponse(this.kind, this.finalPayload);
    for (const [index, partialJson] of this.claudeToolJson) {
      const tool = this.claudeTools.get(index);
      if (!tool || !partialJson) continue;
      try { tool.input = JSON.parse(partialJson); } catch { tool.input = partialJson; }
    }
    const reasoning = [...this.reasoning];
    if (this.kind === 'messages') reasoning.push(...[...this.claudeReasoning.values()].map((item) => structuredClone(item)));
    if (this.kind === 'responses') {
      for (const item of this.responseItems.values()) {
        if (item.type === 'reasoning') reasoning.push(structuredClone(item));
      }
    }
    if (this.kind === 'chat-completions') {
      for (const text of this.chatReasoning.values()) {
        if (text) reasoning.push({ type: 'reasoning', reasoning_content: text });
      }
    }
    const toolCalls = [...this.toolCalls];
    if (this.kind === 'messages') toolCalls.push(...[...this.claudeTools.values()].map((item) => structuredClone(item)));
    if (this.kind === 'chat-completions') toolCalls.push(...[...this.chatTools.values()].map((item) => structuredClone(item)));
    if (this.kind === 'responses') {
      for (const item of this.responseItems.values()) {
        if (typeof item.type === 'string' && item.type.endsWith('_call')) toolCalls.push(structuredClone(item));
      }
    }
    return {
      reasoning,
      toolCalls,
      assistantText: this.assistantText,
      usage: this.usage,
      status: this.status,
    };
  }

  private acceptMessages(payload: JsonObject): void {
    if (payload.type === 'message' && Array.isArray(payload.content)) {
      this.finalPayload = payload;
      return;
    }
    if (payload.type === 'message_start') {
      this.usage = { ...this.usage, ...(payload.message?.usage ?? {}) };
      return;
    }
    if (payload.type === 'message_delta') {
      this.usage = { ...this.usage, ...(payload.usage ?? {}) };
      return;
    }
    const index = typeof payload.index === 'number' ? payload.index : 0;
    if (payload.type === 'content_block_start') {
      const block = payload.content_block;
      if (block?.type === 'text') this.assistantText += block.text ?? '';
      else if (block?.type === 'tool_use') this.claudeTools.set(index, structuredClone(block));
      else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
        this.claudeReasoning.set(index, structuredClone(block));
      }
      return;
    }
    if (payload.type !== 'content_block_delta') return;
    const delta = payload.delta ?? {};
    if (delta.type === 'text_delta') this.assistantText += delta.text ?? '';
    else if (delta.type === 'thinking_delta') {
      const block = this.claudeReasoning.get(index) ?? { type: 'thinking', thinking: '' };
      block.thinking = (block.thinking ?? '') + (delta.thinking ?? '');
      this.claudeReasoning.set(index, block);
    } else if (delta.type === 'signature_delta') {
      const block = this.claudeReasoning.get(index);
      if (block) block.signature = (block.signature ?? '') + (delta.signature ?? '');
    } else if (delta.type === 'input_json_delta') {
      this.claudeToolJson.set(index, (this.claudeToolJson.get(index) ?? '') + (delta.partial_json ?? ''));
    }
  }

  private acceptChat(payload: JsonObject): void {
    if (payload.usage) this.usage = structuredClone(payload.usage);
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    if (choices.some((choice: JsonObject) => choice?.message)) {
      this.finalPayload = payload;
      return;
    }
    for (const choice of choices) {
      const choiceIndex = typeof choice?.index === 'number' ? choice.index : 0;
      const delta = choice?.delta ?? {};
      this.assistantText += contentText(delta.content);
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string') {
        this.chatReasoning.set(choiceIndex, (this.chatReasoning.get(choiceIndex) ?? '') + reasoning);
      }
      for (let position = 0; position < (Array.isArray(delta.tool_calls) ? delta.tool_calls.length : 0); position++) {
        const fragment = delta.tool_calls[position];
        const key = `${choiceIndex}:${typeof fragment?.index === 'number' ? fragment.index : position}`;
        const tool = this.chatTools.get(key) ?? { type: 'function', function: { name: '', arguments: '' } };
        if (fragment?.id !== undefined) tool.id = fragment.id;
        if (fragment?.type !== undefined) tool.type = fragment.type;
        if (fragment?.function?.name) tool.function.name = (tool.function.name ?? '') + fragment.function.name;
        if (fragment?.function?.arguments) tool.function.arguments = (tool.function.arguments ?? '') + fragment.function.arguments;
        this.chatTools.set(key, tool);
      }
    }
  }

  private acceptResponses(payload: JsonObject): void {
    const terminal = payload.type === 'response.completed' || payload.type === 'response.failed'
      || payload.type === 'response.incomplete' || payload.type === 'response.cancelled';
    if ((Array.isArray(payload.output) && !String(payload.type ?? '').startsWith('response.'))
      || (terminal && payload.response)) {
      this.finalPayload = payload.response ?? payload;
      return;
    }
    if (payload.type === 'response.output_text.delta') this.assistantText += payload.delta ?? '';
    const itemId = payload.item_id ?? payload.item?.id;
    if (itemId !== undefined && payload.item) {
      this.responseItems.set(String(itemId), structuredClone(payload.item));
    }
    if (itemId !== undefined && (payload.type === 'response.reasoning_summary_text.delta'
      || payload.type === 'response.reasoning_text.delta')) {
      const item = this.responseItems.get(String(itemId)) ?? { id: itemId, type: 'reasoning' };
      if (payload.type === 'response.reasoning_summary_text.delta') {
        item.summary = item.summary ?? [{ type: 'summary_text', text: '' }];
        item.summary[0].text += payload.delta ?? '';
      } else {
        item.content = item.content ?? [{ type: 'reasoning_text', text: '' }];
        item.content[0].text += payload.delta ?? '';
      }
      this.responseItems.set(String(itemId), item);
    }
    if (itemId !== undefined && (payload.type === 'response.function_call_arguments.delta'
      || payload.type === 'response.function_call_arguments.done')) {
      const item = this.responseItems.get(String(itemId)) ?? { id: itemId, type: 'function_call', arguments: '' };
      item.arguments = payload.type === 'response.function_call_arguments.done'
        ? payload.arguments ?? ''
        : (item.arguments ?? '') + (payload.delta ?? '');
      this.responseItems.set(String(itemId), item);
    }
  }

  private acceptGemini(payload: JsonObject): void {
    const normalized = normalizeJsonResponse(this.kind, payload);
    this.assistantText += normalized.assistantText;
    this.reasoning.push(...normalized.reasoning);
    this.toolCalls.push(...normalized.toolCalls);
    if (payload.usageMetadata) this.usage = structuredClone(payload.usageMetadata);
  }

  private acceptInteraction(payload: JsonObject): void {
    if (payload.type === 'error' || payload.event_type === 'error') {
      this.status = 'failed';
      return;
    }
    if (payload.event_type === 'interaction.completed' && payload.interaction) {
      this.finalPayload = payload.interaction;
      return;
    }
    if (payload.object === 'interaction') {
      this.finalPayload = payload;
      return;
    }
    if (payload.event_type === 'step.start' && payload.step && typeof payload.step.type === 'string'
      && payload.step.type.endsWith('_call')) {
      this.toolCalls.push(structuredClone(payload.step));
    }
    if (payload.event_type === 'step.delta') {
      const delta = payload.delta ?? {};
      if (typeof delta.text === 'string') this.assistantText += delta.text;
      if (delta.content) {
        const content: NormalizedResponse = {
          reasoning: this.reasoning,
          toolCalls: this.toolCalls,
          assistantText: '',
          usage: {},
        };
        addInteractionContent([delta.content], content);
        this.assistantText += content.assistantText;
      }
    }
    if (payload.interaction?.usage) this.usage = structuredClone(payload.interaction.usage);
  }
}

export function appendTrajectoryRecord(filePath: string, record: TrajectoryRecord): void {
  const fd = openSync(filePath, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
  } finally {
    closeSync(fd);
  }
}

export function recordTrajectoryResponse(
  response: Response,
  context: TrajectoryRequestContext,
  logger: Logger,
  filePath = TRAJECTORY_LOG_FILE,
): Response {
  const accumulator = new ResponseAccumulator(context.kind);
  const isSse = (response.headers.get('content-type') || '').includes('text/event-stream');
  const decoder = new TextDecoder();
  let pendingSse = '';
  let jsonText = '';
  let finalized = false;
  let warnedAboutJson = false;

  const warnAboutJson = (error: unknown): void => {
    if (warnedAboutJson) return;
    warnedAboutJson = true;
    logger.warn(context.requestId, `[trajectory] could not parse a client response JSON payload: ${(error as Error).message}`);
  };

  const acceptJson = (text: string): void => {
    if (!text.trim() || text.trim() === '[DONE]') return;
    try {
      const payload = JSON.parse(text);
      if (payload && typeof payload === 'object') accumulator.accept(payload as JsonObject);
    } catch (error) {
      warnAboutJson(error);
    }
  };

  const acceptSseFrame = (frame: string): void => {
    const data = frame.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data) acceptJson(data);
  };

  const acceptSseText = (text: string, final = false): void => {
    const normalized = (pendingSse + text).replace(/\r\n/g, '\n');
    const frames = normalized.split('\n\n');
    pendingSse = frames.pop() ?? '';
    for (const frame of frames) acceptSseFrame(frame);
    if (final && pendingSse) {
      acceptSseFrame(pendingSse);
      pendingSse = '';
    }
  };

  const finalize = (completionStatus: 'completed' | 'failed' | 'cancelled'): void => {
    if (finalized) return;
    finalized = true;
    let normalized: NormalizedResponse = {
      reasoning: [], toolCalls: [], assistantText: '', usage: {},
    };
    try {
      const tail = decoder.decode();
      if (isSse) acceptSseText(tail, true);
      else {
        jsonText += tail;
        acceptJson(jsonText);
      }
      normalized = accumulator.result();
    } catch (error) {
      logger.error(context.requestId, `[trajectory] could not normalize the client response: ${(error as Error).message}`);
    }
    const record: TrajectoryRecord = {
      session_id: context.sessionId,
      request_id: context.requestId,
      sequence: context.sequence,
      timestamp: new Date().toISOString(),
      type: 'action',
      request_messages: context.requestMessages,
      reasoning: normalized.reasoning,
      tool_calls: normalized.toolCalls,
      tool_results: context.toolResults,
      assistant_text: normalized.assistantText,
      usage: normalized.usage,
      status: completionStatus !== 'completed'
        ? completionStatus
        : response.ok ? normalized.status ?? 'completed' : 'failed',
    };
    try {
      appendTrajectoryRecord(filePath, record);
    } catch (error) {
      logger.error(context.requestId, `[trajectory] could not append to ${filePath}: ${(error as Error).message}`);
    }
  };

  if (!response.body) {
    finalize(response.ok ? 'completed' : 'failed');
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finalize(response.ok ? 'completed' : 'failed');
          controller.close();
          return;
        }
        const text = decoder.decode(value, { stream: true });
        if (isSse) acceptSseText(text);
        else jsonText += text;
        controller.enqueue(value);
      } catch (error) {
        finalize('failed');
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finalize('cancelled');
      }
    },
  });
  return new Response(body, response);
}
