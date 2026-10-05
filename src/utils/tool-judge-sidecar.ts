/**
 * Tool Judge Sidecar Client
 * Calls a local sidecar to judge tool relevance against user prompt.
 * Fails OPEN — any error/timeout keeps all tools.
 *
 * Wire format is docs/architecture/design_tool_judge_sidecar_protocol.md:
 *   §2.2/§2.3 request  — { state, questions: { <question_id>: <question> } }
 *   §2.4/§2.5 response — { <question_id>: <answer> }  (a top-level map)
 * `noul`  (batch)  — one question per tool in a single request, keyed by tool name.
 * `choice`(single) — one request per tool, question id `decision`.
 */

import type { ProxyConfig } from './config-loader.js';
import { createLogger } from './logger.js';
import { extractToolRecords, type ToolRecord } from './tool-shapes.js';

const logger = createLogger({});

// The sidecar is a small encoder (Laya runs with max_len=512 tokens), so the
// state has to stay inside that budget: an unbounded tool-schema dump would
// blow the token budget and every judge call would fail open. Caps below keep
// the state useful and bounded.
const MAX_PROMPT_CHARS = 2000;
const MAX_SCHEMA_CHARS = 600;
const MAX_CONTEXT_MESSAGES = 3;
const MAX_CONTEXT_TOOL_CALLS = 5;

// Request/Response types matching the design doc

export interface JudgeSidecarConfig {
  judge_url: string;
  timeoutMs: number;
  threshold: number;
  mode: 'choice' | 'noul';
  apiKey?: string;
  maxBatchTools: number;
}


export interface JudgeRequest {
  state: string;
  questions: Record<string, JudgeQuestion>;
}

export interface JudgeChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: string[];
}

export interface JudgeNoulQuestion {
  type: 'noul';
  instructions: string;
}

export type JudgeQuestion = JudgeChoiceQuestion | JudgeNoulQuestion;

/** One answer object — doc §2.4 (`choice`) or §2.5 (`noul`). */
export interface JudgeAnswer {
  type: 'choice' | 'noul';
  confidence: number;
  action: { act_probability: number };
  /** `choice` only: winning criterion label. */
  choice?: string;
  /** `choice` only: probability per criterion label. */
  probabilities?: Record<string, number>;
  /** `noul` only: relevance score 0.0–1.0. */
  noul?: number;
}

/** Top-level sidecar response: map of question id → answer (doc §2.4/§2.5). */
export type JudgeResponse = Record<string, JudgeAnswer>;

/** One tool's judged outcome (doc §5.1/§5.2). */
export interface JudgeDecision {
  toolName: string;
  /** keep probability (`choice`) or relevance score (`noul`). */
  factor: number;
  action: 'keep' | 'erase';
  reason: string;
}

// Result of the sidecar call
export interface JudgeResult {
  /** Tools to erase (at or below threshold) */
  eraseNames: string[];
  /** Tools the sidecar returned a decision for (for logging) */
  judgedNames: string[];
  /** Tools sent to the sidecar that it returned no decision for — kept (fail-open) */
  unjudgedNames: string[];
  /** Tools never sent because they exceeded max_batch_tools — kept (fail-open) */
  skippedNames: string[];
  /** Raw sidecar response for debugging */
  rawResponse?: JudgeResponse;
  /** Whether the sidecar was called */
  called: boolean;
  /** Set when some or all tools went unjudged (fails open) */
  error?: string;
}

/**
 * Build the judge `state` text from the request body and the tools to judge
 * (design doc §4.1). Each `ToolRecord` is a provider-native tool definition
 * reduced to what the judge needs; its schema is serialized into the text.
 */
export function buildStateText(body: Record<string, unknown>, tools: ToolRecord[]): string {
  const userTexts: string[] = [];
  const toolCalls: Array<{ name: string; args: unknown }> = [];

  for (const turn of conversationTurns(body)) {
    if (!turn || typeof turn !== 'object') continue;
    const m = turn as Record<string, unknown>;
    // Gemini names the assistant turn `model` and carries content in `parts`.
    const role = m.role === 'model' ? 'assistant' : m.role;
    const content = m.parts ?? m.content;
    if (role === 'user') {
      const text = messageText(content);
      if (text) userTexts.push(text);
    } else if (role === 'assistant') {
      toolCalls.push(...messageToolCalls(m, content));
    }
  }

  // The final user message is the prompt being judged; earlier ones are context.
  const userPrompt = userTexts.length > 0 ? userTexts[userTexts.length - 1] : '';
  const recentUserMessages = userTexts
    .slice(0, -1)
    .slice(-MAX_CONTEXT_MESSAGES);
  const recentToolCalls = toolCalls.slice(-MAX_CONTEXT_TOOL_CALLS);

  const lines = [
    `User prompt: "${truncate(userPrompt, MAX_PROMPT_CHARS)}"`,
    '',
    'Tools to evaluate:',
  ];
  tools.forEach((tool, i) => {
    lines.push(`${i + 1}. ${tool.name}: ${truncate(JSON.stringify(tool.schema), MAX_SCHEMA_CHARS)}`);
  });

  if (recentUserMessages.length > 0 || recentToolCalls.length > 0) {
    lines.push('', 'Recent context:');
    for (const msg of recentUserMessages) {
      lines.push(`- User: "${truncate(msg, MAX_PROMPT_CHARS)}"`);
    }
    for (const call of recentToolCalls) {
      lines.push(`- Assistant called: ${call.name}(${JSON.stringify(call.args)})`);
    }
  }

  return lines.join('\n');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * The conversation turns under whichever name the provider uses: Claude/OpenAI
 * `messages`, or Gemini native `contents`. `messages` wins when both are
 * present so a Gemini-shaped body that also carries them keeps its richer form.
 */
function conversationTurns(body: Record<string, unknown>): unknown[] {
  if (Array.isArray(body.messages) && body.messages.length > 0) return body.messages;
  if (Array.isArray(body.contents)) return body.contents;
  return [];
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object') {
      const text = (block as Record<string, unknown>).text;
      if (typeof text === 'string') texts.push(text);
    }
  }
  return texts.join('\n');
}

/**
 * Recent assistant tool calls: Claude `tool_use` blocks, OpenAI `tool_calls`,
 * Gemini `functionCall` parts. `content` is the turn's block list — Claude/
 * OpenAI `content`, or Gemini `parts`.
 */
function messageToolCalls(
  message: Record<string, unknown>,
  content: unknown,
): Array<{ name: string; args: unknown }> {
  const calls: Array<{ name: string; args: unknown }> = [];

  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_use' && typeof b.name === 'string') {
        calls.push({ name: b.name, args: b.input ?? {} });
      } else if (b.functionCall && typeof b.functionCall === 'object') {
        const fc = b.functionCall as Record<string, unknown>;
        if (typeof fc.name === 'string') calls.push({ name: fc.name, args: fc.args ?? {} });
      }
    }
  }

  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!call || typeof call !== 'object') continue;
      const fn = (call as Record<string, unknown>).function;
      if (fn && typeof fn === 'object') {
        const f = fn as Record<string, unknown>;
        if (typeof f.name === 'string') calls.push({ name: f.name, args: parseArguments(f.arguments) });
      }
    }
  }

  // Legacy OpenAI shape: { function_call: { name, arguments } }
  const functionCall = message.function_call;
  if (functionCall && typeof functionCall === 'object') {
    const f = functionCall as Record<string, unknown>;
    if (typeof f.name === 'string') calls.push({ name: f.name, args: parseArguments(f.arguments) });
  }

  return calls;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Build the judge request for "choice" mode (doc §4.2 — one tool per request).
 * The single-tool state carries only that tool's schema (doc §2.2).
 */
export function buildChoiceRequest(state: string): JudgeRequest {
  return {
    state,
    questions: {
      decision: {
        type: 'choice',
        instructions: 'Should this tool be kept or discarded based on the user prompt and context?',
        criteria: ['keep', 'discard'],
      },
    },
  };
}

/**
 * Build the judge request for "noul" mode (doc §4.2 — one question per tool)
 */
export function buildNoulRequest(state: string, toolNames: string[]): JudgeRequest {
  const questions: Record<string, JudgeNoulQuestion> = {};
  for (const name of toolNames) {
    questions[name] = { type: 'noul', instructions: `Keep ${name} tool?` };
  }
  return { state, questions };
}

/**
 * Parse a `choice` response (doc §5.1). Throws on a malformed answer — the
 * caller fails open per tool.
 */
export function parseChoiceResponse(
  response: JudgeResponse,
  toolName: string,
  threshold: number,
): JudgeDecision {
  const answer = response.decision;
  if (!answer || answer.type !== 'choice') {
    throw new Error(`Invalid choice response: ${JSON.stringify(answer ?? null)}`);
  }
  const keepProb = answer.probabilities?.keep ?? 0;
  return {
    toolName,
    factor: keepProb,
    action: keepProb > threshold ? 'keep' : 'erase',
    reason: `choice: keep=${keepProb.toFixed(2)}, choice=${answer.choice}`,
  };
}

/**
 * Parse a `noul` response (doc §5.2). A tool missing from the response keeps
 * with `factor = 1.0` rather than being treated as irrelevant.
 */
export function parseNoulResponse(
  response: JudgeResponse,
  toolNames: string[],
  threshold: number,
): JudgeDecision[] {
  const decisions: JudgeDecision[] = [];
  for (const toolName of toolNames) {
    const answer = response[toolName];
    if (!answer || answer.type !== 'noul') {
      decisions.push({ toolName, factor: 1.0, action: 'keep', reason: 'missing from response' });
      continue;
    }
    const noul = answer.noul ?? 0;
    decisions.push({
      toolName,
      factor: noul,
      action: noul > threshold ? 'keep' : 'erase',
      reason: `noul=${noul.toFixed(2)}`,
    });
  }
  return decisions;
}

/**
 * Call the judge sidecar with the given request. Returns null on any failure
 * (timeout, non-2xx, malformed body) so the caller can fail open.
 */
export async function callJudgeSidecar(
  config: JudgeSidecarConfig,
  request: JudgeRequest,
  requestId: string,
): Promise<JudgeResponse | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    const resp = await fetch(judgeEndpoint(config.judge_url), {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!resp.ok) {
      logger.warn(requestId, `Tool judge sidecar returned ${resp.status}: ${resp.statusText}`);
      return null;
    }

    const text = await resp.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      logger.warn(requestId, `Tool judge sidecar returned malformed JSON: ${truncate(text, 200)}`);
      return null;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      logger.warn(requestId, `Tool judge sidecar returned non-object body: ${truncate(text, 200)}`);
      return null;
    }

    return data as JudgeResponse;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      logger.warn(requestId, `Tool judge sidecar timeout (${config.timeoutMs}ms)`);
    } else {
      logger.warn(requestId, `Tool judge sidecar error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
}

/**
 * `judge_url` is the sidecar base URL (`http://127.0.0.1:8081`); the `/judge`
 * path is appended here. An already-complete `/judge` URL is left alone so a
 * config written against the doc's full-URL example still resolves.
 */
function judgeEndpoint(judgeUrl: string): string {
  const base = judgeUrl.replace(/\/+$/, '');
  return /\/judge$/.test(base) ? base : `${base}/judge`;
}

/**
 * Main entry point: judge tools and return names to erase
 * Fails open — returns empty array on any error
 */
export async function judgeTools(
  body: Record<string, unknown>,
  proxyConfig: ProxyConfig,
  requestId: string,
): Promise<JudgeResult> {
  const sidecarConfig = proxyConfig.tool_judge_sidecar;
  if (!sidecarConfig?.judge_url) {
    return { eraseNames: [], judgedNames: [], unjudgedNames: [], skippedNames: [], called: false };
  }

  const tools = extractToolRecords(body);
  if (tools.length === 0) {
    return { eraseNames: [], judgedNames: [], unjudgedNames: [], skippedNames: [], called: false };
  }

  // Tools past the batch cap are never sent — kept, but reported so the
  // overflow is not a silent no-op.
  const maxBatch = sidecarConfig.max_batch_tools ?? 50;
  const toolsToJudge = tools.slice(0, maxBatch);
  const skippedNames = tools.slice(maxBatch).map((tool) => tool.name);

  const config: JudgeSidecarConfig = {
    judge_url: sidecarConfig.judge_url,
    timeoutMs: sidecarConfig.timeout_ms ?? 50,
    threshold: sidecarConfig.threshold ?? 0.5,
    mode: sidecarConfig.mode ?? 'choice',
    apiKey: sidecarConfig.api_key,
    maxBatchTools: maxBatch,
  };

  const startedAt = Date.now();
  const toolNames = toolsToJudge.map((tool) => tool.name);
  logger.debug(requestId, `Calling tool judge sidecar (${config.mode}, ${toolsToJudge.length} tools)`);

  let decisions: JudgeDecision[] = [];
  const unjudgedNames: string[] = [];
  let rawResponse: JudgeResponse | undefined;
  let callFailed = false;

  if (config.mode === 'choice') {
    // Doc §2.2 is single-tool: one request per tool, each with its own state.
    for (const tool of toolsToJudge) {
      const response = await callJudgeSidecar(
        config,
        buildChoiceRequest(buildStateText(body, [tool])),
        requestId,
      );
      if (!response) {
        unjudgedNames.push(tool.name);
        continue;
      }
      try {
        decisions.push(parseChoiceResponse(response, tool.name, config.threshold));
      } catch (err) {
        logger.warn(
          requestId,
          `Tool judge sidecar gave an unusable answer for ${tool.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
        unjudgedNames.push(tool.name);
      }
    }
    callFailed = decisions.length === 0;
  } else {
    const response = await callJudgeSidecar(
      config,
      buildNoulRequest(buildStateText(body, toolsToJudge), toolNames),
      requestId,
    );
    if (!response) {
      callFailed = true;
      unjudgedNames.push(...toolNames);
    } else {
      rawResponse = response;
      decisions = parseNoulResponse(response, toolNames, config.threshold);
      for (const decision of decisions) {
        if (decision.reason === 'missing from response') unjudgedNames.push(decision.toolName);
      }
    }
  }

  const eraseNames = decisions.filter((d) => d.action === 'erase').map((d) => d.toolName);
  const judgedNames = decisions
    .filter((d) => d.reason !== 'missing from response')
    .map((d) => d.toolName);
  const elapsedMs = Date.now() - startedAt;

  // Fail loud: anything the sidecar did not decide is reported, not hidden.
  const summary =
    `Tool judge sidecar (mode=${config.mode}, threshold=${config.threshold}): ` +
    `${judgedNames.length}/${toolsToJudge.length} judged, ${eraseNames.length} to erase` +
    (unjudgedNames.length > 0 ? `, ${unjudgedNames.length} unjudged (kept)` : '') +
    (skippedNames.length > 0
      ? `, ${skippedNames.length} over max_batch_tools=${maxBatch} (kept)`
      : '') +
    ` in ${elapsedMs}ms`;

  let error: string | undefined;
  if (toolsToJudge.length > 0 && judgedNames.length === 0) {
    error = `Sidecar judged none of ${toolsToJudge.length} tools — failing open`;
    logger.warn(requestId, summary);
  } else {
    const notes: string[] = [];
    if (unjudgedNames.length > 0) notes.push(`${unjudgedNames.length} of ${toolsToJudge.length} tools unjudged (kept)`);
    if (skippedNames.length > 0) notes.push(`${skippedNames.length} tools over max_batch_tools=${maxBatch} (kept)`);
    if (notes.length > 0) {
      error = notes.join('; ');
      logger.warn(requestId, summary);
    } else {
      logger.info(requestId, summary);
    }
  }

  if (callFailed && eraseNames.length === 0 && decisions.length === 0) {
    return {
      eraseNames,
      judgedNames,
      unjudgedNames,
      skippedNames,
      called: true,
      error: error ?? 'Sidecar call failed (timeout or error) — failing open',
    };
  }

  return {
    eraseNames,
    judgedNames,
    unjudgedNames,
    skippedNames,
    rawResponse,
    called: true,
    error,
  };
}
