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
// state has to stay inside that budget: each tool appears as just its name and
// description — a schema dump would blow the token budget and every judge call
// would fail open. Caps below keep the state useful and bounded.
const MAX_PROMPT_CHARS = 2000;
const MAX_TOOL_DESCRIPTION_CHARS = 600;
const MAX_CONTEXT_MESSAGES = 3;
const MAX_CONTEXT_TOOL_CALLS = 5;

// Request/Response types matching the design doc

export interface JudgeSidecarConfig {
  judge_url: string;
  /**
   * Per-question budget; a request carrying N questions gets N × this, capped
   * at 2000ms total. See {@link requestTimeoutMs}.
   */
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
  /** Erased tool name → judge factor (noul score / keep probability), for logging */
  eraseFactors?: Record<string, number>;
  /** Raw sidecar response for debugging */
  rawResponse?: JudgeResponse;
  /** Whether the sidecar was called */
  called: boolean;
  /** Set when some or all tools went unjudged (fails open) */
  error?: string;
}

/**
 * Build the judge `state` text from the request body and the tools to judge
 * (design doc §4.1). Each `ToolRecord` is reduced to what the judge needs:
 * its name and description — the parameter schema is not sent.
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
  const userPrompt = userTexts.length > 0 ? stripClientInjectedContent(userTexts[userTexts.length - 1]) : '';
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
    const description = tool.description
      ? `: ${truncate(tool.description, MAX_TOOL_DESCRIPTION_CHARS)}`
      : '';
    lines.push(`${i + 1}. ${tool.name}${description}`);
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
 * Client-injected (not user-typed) content stripped from the judged prompt.
 * These blocks are added by the client harness around the real user input, carry
 * no tool-relevance signal, and burn the sidecar's small token budget:
 *   - system-reminder       Claude Code context injection (date, cwd, git status…)
 *   - environment_context   Codex environment block (cwd, shell, permissions…)
 *   - local-command-stdout  Claude Code `! cmd` output
 *   - local-command-stderr
 *   - ide_opened_file       Claude Code IDE-integration context
 *   - ide_selection
 * Tag blocks are removed with their contents plus the whitespace clients pad
 * them with (including indentation between adjacent blocks); the open/close
 * names must match (\1 backreference), so an unclosed or mismatched tag passes
 * through untouched. The Claude Code local-command "Caveat:" paragraph is
 * matched to end-of-line.
 *
 * Claude Code slash-command wrappers get split treatment: <command-message> is
 * client boilerplate and is stripped outright, while <command-name> and
 * <command-args> hold what the user actually typed, so they are UNWRAPPED —
 * tags removed, inner text kept.
 *
 * Stripping runs in three layers (see stripClientInjectedContent):
 *   1. the known-tag list below,
 *   2. a generalized pass stripping ANY leading blank-line-separated tag block,
 *      which covers clients whose tag names we don't know,
 *   3. only if no tag matched at all, a heuristic that drops leading paragraphs
 *      made entirely of machine-looking lines (key: value, dates, paths).
 * Layers 2–3 can false-positive on user text that happens to look injected
 * (e.g. a leading XML example, or a pasted config block followed by a question)
 * — the blast radius is limited to the judge's view; the upstream request body
 * is never touched.
 */
const CLIENT_INJECTED_TAGS = [
  'system-reminder',
  'environment_context',
  'local-command-stdout',
  'local-command-stderr',
  'ide_opened_file',
  'ide_selection',
  'command-message',
];

const CLIENT_INJECTED_BLOCK_RE = new RegExp(
  `\\s*<(${CLIENT_INJECTED_TAGS.join('|')})>[\\s\\S]*?</\\1>\\s*`,
  'g',
);

const CLIENT_INJECTED_CAVEAT_RE =
  /\n*Caveat: The messages below were generated by the user while running local commands\.[^\n]*\n*/g;

/** Claude Code slash-command wrappers whose inner text is user-typed: unwrap. */
const CLIENT_COMMAND_UNWRAP_RE =
  /<\/(command-name|command-args)>|<(command-name|command-args)>/g;

function stripClientInjectedContent(text: string): string {
  const knownStripped = text
    .replace(CLIENT_INJECTED_BLOCK_RE, '\n')
    .replace(CLIENT_INJECTED_CAVEAT_RE, '\n')
    .replace(CLIENT_COMMAND_UNWRAP_RE, '')
    .trim();
  const tagStripped = stripLeadingTaggedBlocks(knownStripped).trim();
  if (tagStripped !== text.trim()) {
    // A tag-based rule matched; what remains is the prompt.
    return tagStripped;
  }
  // No tag matched at all. Last resort: if the message is blank-line-separated
  // paragraphs and the leading ones look machine-generated (config dumps,
  // timestamps), drop them and keep from the first human-looking paragraph on.
  return dropMachineLeadingParagraphs(tagStripped).trim();
}

/**
 * Fallback for clients whose injected context uses tags outside the known list:
 * strip leading paragraphs that are wholly enclosed in a matched tag pair and
 * followed by a blank line (or end of message) — the shape every observed
 * injection takes. Plain-text paragraphs never match, so real multi-paragraph
 * user input passes through untouched.
 */
function stripLeadingTaggedBlocks(text: string): string {
  const blockStart = /^\s*<([a-zA-Z][a-zA-Z0-9_-]*)>[\s\S]*?<\/\1>(?:\n{2,}|\s*$)/;
  let rest = text;
  for (;;) {
    const m = blockStart.exec(rest);
    if (!m) return rest;
    rest = rest.slice(m[0].length);
  }
}

/**
 * A line "looks machine-generated" when it is structured data rather than
 * prose: a `key: value` line, an ISO date, a single-line tag pair, or a bare
 * path. A paragraph qualifies only when EVERY line qualifies — one prose line
 * anywhere keeps the paragraph, which is what protects real user text.
 */
const STRUCTURED_LINE_RES = [
  /^[\w .-]+:\s*\S/,                       // key: value ("cwd: /Users/x")
  /\b\d{4}-\d{2}-\d{2}\b/,                 // ISO date anywhere in the line
  /^<[^>\s]+(\s[^>]*)?>.*<\/[^>\s]+>\s*$/, // single-line tag-wrapped content
  /^([~\/]|[A-Za-z]:[\\\/])\S*$/,          // bare absolute path
];

function looksMachineGenerated(paragraph: string): boolean {
  const lines = paragraph.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((l) => STRUCTURED_LINE_RES.some((re) => re.test(l)));
}

function dropMachineLeadingParagraphs(text: string): string {
  const paragraphs = text.split(/\n{2,}/);
  if (paragraphs.length < 2) return text;
  let firstHuman = 0;
  while (firstHuman < paragraphs.length - 1 && looksMachineGenerated(paragraphs[firstHuman])) {
    firstHuman++;
  }
  return paragraphs.slice(firstHuman).join('\n\n');
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
 * Ceiling on what a single request may be budgeted, however many tools it
 * batches. The proxy is blocked on this call, so an unbounded scale would let a
 * large batch stall a user's request far past the point of usefulness.
 */
const MAX_REQUEST_TIMEOUT_MS = 2000;

/**
 * `timeout_ms` is a per-question budget, not a per-request one. `noul` mode
 * packs one question per tool into a single request, so a flat budget would
 * make a 50-tool batch more likely to time out than a 1-tool one and fail the
 * whole batch open. Scaling by question count also puts the two modes on the
 * same footing: N tools get at most N × `timeout_ms` either way, since choice
 * mode spends that as N sequential single-question requests.
 *
 * The cap bounds the scaling, not an explicitly larger `timeout_ms` — a base
 * budget already above the cap is never shrunk to it.
 */
export function requestTimeoutMs(config: JudgeSidecarConfig, questionCount: number): number {
  const budget = config.timeoutMs * Math.max(1, questionCount);
  const ceiling = Math.max(config.timeoutMs, MAX_REQUEST_TIMEOUT_MS);
  return Math.min(budget, ceiling);
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
  const questionCount = Object.keys(request.questions).length;
  const timeoutMs = requestTimeoutMs(config, questionCount);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    const bodyJson = JSON.stringify(request);
    logger.debug(
      requestId,
      `Tool judge sidecar request to ${judgeEndpoint(config.judge_url)} ` +
        `(${config.mode} mode, ${questionCount} question(s), timeout ${timeoutMs}ms): ${truncate(bodyJson, 4000)}`,
    );

    const resp = await fetch(judgeEndpoint(config.judge_url), {
      method: 'POST',
      headers,
      body: bodyJson,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!resp.ok) {
      logger.warn(requestId, `Tool judge sidecar returned ${resp.status}: ${resp.statusText}`);
      return null;
    }

    const text = await resp.text();
    logger.debug(
      requestId,
      `Tool judge sidecar raw response (${resp.status}, ${questionCount} question(s)): ${truncate(text, 4000)}`,
    );
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
      logger.warn(
        requestId,
        `Tool judge sidecar timeout (${timeoutMs}ms for ${questionCount} question(s))`,
      );
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

  // Every tool is judged: noul mode batches into sequential chunks of
  // max_batch_tools (one request per chunk), choice mode already sends one
  // request per tool. skippedNames stays in the result shape for callers but
  // is always empty.
  const maxBatch = sidecarConfig.max_batch_tools ?? 50;
  const skippedNames: string[] = [];

  const config: JudgeSidecarConfig = {
    judge_url: sidecarConfig.judge_url,
    timeoutMs: sidecarConfig.timeout_ms ?? 50,
    threshold: sidecarConfig.threshold ?? 0.5,
    mode: sidecarConfig.mode ?? 'choice',
    apiKey: sidecarConfig.api_key,
    maxBatchTools: maxBatch,
  };

  const startedAt = Date.now();
  logger.debug(requestId, `Calling tool judge sidecar (${config.mode}, ${tools.length} tools)`);

  const decisions: JudgeDecision[] = [];
  const unjudgedNames: string[] = [];
  let rawResponse: JudgeResponse | undefined;
  let callFailed = false;

  if (config.mode === 'choice') {
    // Doc §2.2 is single-tool: one request per tool, each with its own state.
    for (const tool of tools) {
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
    // Doc §2.3 batch mode, chunked: one request per max_batch_tools chunk, each
    // carrying only its own tools' schemas so the sidecar's small token budget
    // is per-chunk rather than per-request. A failed chunk fails open for just
    // its own tools; the rest are still judged.
    for (let i = 0; i < tools.length; i += maxBatch) {
      const chunk = tools.slice(i, i + maxBatch);
      const chunkNames = chunk.map((tool) => tool.name);
      const response = await callJudgeSidecar(
        config,
        buildNoulRequest(buildStateText(body, chunk), chunkNames),
        requestId,
      );
      if (!response) {
        unjudgedNames.push(...chunkNames);
        continue;
      }
      rawResponse = { ...rawResponse, ...response };
      const chunkDecisions = parseNoulResponse(response, chunkNames, config.threshold);
      decisions.push(...chunkDecisions);
      for (const decision of chunkDecisions) {
        if (decision.reason === 'missing from response') unjudgedNames.push(decision.toolName);
      }
    }
    callFailed = decisions.length === 0;
  }

  const eraseNames = decisions.filter((d) => d.action === 'erase').map((d) => d.toolName);
  const judgedNames = decisions
    .filter((d) => d.reason !== 'missing from response')
    .map((d) => d.toolName);
  const elapsedMs = Date.now() - startedAt;

  for (const decision of decisions) {
    logger.debug(
      requestId,
      `Tool judge sidecar: ${decision.toolName} -> ${decision.action} ` +
        `(confidence=${decision.factor.toFixed(4)}, ${decision.reason})`,
    );
  }
  for (const name of unjudgedNames) {
    logger.debug(requestId, `Tool judge sidecar: ${name} -> unjudged (kept)`);
  }

  // Fail loud: anything the sidecar did not decide is reported, not hidden.
  const summary =
    `Tool judge sidecar (mode=${config.mode}, threshold=${config.threshold}): ` +
    `${judgedNames.length}/${tools.length} judged, ${eraseNames.length} to erase` +
    (unjudgedNames.length > 0 ? `, ${unjudgedNames.length} unjudged (kept)` : '') +
    ` in ${elapsedMs}ms`;

  let error: string | undefined;
  if (tools.length > 0 && judgedNames.length === 0) {
    error = `Sidecar judged none of ${tools.length} tools — failing open`;
    logger.warn(requestId, summary);
  } else {
    const notes: string[] = [];
    if (unjudgedNames.length > 0) notes.push(`${unjudgedNames.length} of ${tools.length} tools unjudged (kept)`);
    if (notes.length > 0) {
      error = notes.join('; ');
      logger.warn(requestId, summary);
    } else {
      logger.info(requestId, summary);
    }
  }

  const eraseFactors = Object.fromEntries(
    decisions.filter((d) => d.action === 'erase').map((d) => [d.toolName, d.factor]),
  );

  if (callFailed && eraseNames.length === 0 && decisions.length === 0) {
    return {
      eraseNames,
      judgedNames,
      unjudgedNames,
      skippedNames,
      eraseFactors,
      called: true,
      error: error ?? 'Sidecar call failed (timeout or error) — failing open',
    };
  }

  return {
    eraseNames,
    judgedNames,
    unjudgedNames,
    skippedNames,
    eraseFactors,
    rawResponse,
    called: true,
    error,
  };
}
