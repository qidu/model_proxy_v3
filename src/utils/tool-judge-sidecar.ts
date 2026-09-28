/**
 * Tool Judge Sidecar Client
 * Calls a local sidecar to judge tool relevance against user prompt.
 * Fails OPEN — any error/timeout keeps all tools.
 */

import type { ProxyConfig } from './config-loader.js';
import { createLogger } from './logger.js';

const logger = createLogger({});

// Request/Response types matching the design doc

export interface JudgeSidecarConfig {
  url: string;
  timeoutMs: number;
  threshold: number;
  mode: 'choice' | 'noul';
  apiKey?: string;
  maxBatchTools: number;
}

export interface JudgeRequest {
  state: string;
  questions: JudgeQuestions;
}

export interface JudgeQuestions {
  decision?: JudgeChoiceQuestion;
  keep?: JudgeNoulQuestion;
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

export interface JudgeResponse {
  answer: JudgeAnswer;
}

export interface JudgeAnswer {
  decision?: JudgeChoiceAnswer;
  keep?: JudgeNoulAnswer;
}

export interface JudgeChoiceAnswer {
  type: 'choice';
  decision: string;
  probabilities: Record<string, number>;
}

export interface JudgeNoulAnswer {
  type: 'noul';
  items: Record<string, number>;
}

// Result of the sidecar call
export interface JudgeResult {
  /** Tools to erase (below threshold) */
  eraseNames: string[];
  /** Tools that were judged (for logging) */
  judgedNames: string[];
  /** Raw sidecar response for debugging */
  rawResponse?: JudgeResponse;
  /** Whether the sidecar was called */
  called: boolean;
  /** Error message if sidecar failed (fails open) */
  error?: string;
}

/**
 * Extract tool names from request body (supports OpenAI, Anthropic, Gemini formats)
 */
export function extractToolNames(body: Record<string, unknown>): string[] {
  const tools = body.tools;
  if (!Array.isArray(tools)) return [];

  const names: string[] = [];
  for (const tool of tools) {
    if (tool && typeof tool === 'object') {
      // OpenAI format: { type: 'function', function: { name: '...' } }
      if (tool.type === 'function' && tool.function && typeof tool.function === 'object') {
        const fnName = (tool.function as Record<string, unknown>).name;
        if (typeof fnName === 'string') names.push(fnName);
      }
      // Anthropic format: { name: '...', ... }
      else if (typeof tool.name === 'string') {
        names.push(tool.name);
      }
      // Gemini format: { function_declarations: [{ name: '...' }] }
      else if (Array.isArray((tool as Record<string, unknown>).function_declarations)) {
        for (const decl of (tool as Record<string, unknown>).function_declarations as unknown[]) {
          if (decl && typeof decl === 'object' && typeof (decl as Record<string, unknown>).name === 'string') {
            names.push((decl as Record<string, unknown>).name as string);
          }
        }
      }
    }
  }
  return names;
}

/**
 * Build the prompt state text from the request body
 * Includes user messages and tool definitions
 */
export function buildStateText(body: Record<string, unknown>, toolNames: string[]): string {
  const parts: string[] = [];

  // Add user messages (last few for context)
  const messages = body.messages;
  if (Array.isArray(messages)) {
    const userMessages = messages
      .filter((m): m is Record<string, unknown> => m && typeof m === 'object' && m.role === 'user')
      .slice(-3); // Last 3 user messages
    for (const msg of userMessages) {
      const content = msg.content;
      if (typeof content === 'string') {
        parts.push(`User: ${content.slice(0, 2000)}`);
      } else if (Array.isArray(content)) {
        // Anthropic-style content blocks
        for (const block of content) {
          if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
            parts.push(`User: ${block.text.slice(0, 2000)}`);
          }
        }
      }
    }
  }

  // Add tool definitions summary
  if (toolNames.length > 0) {
    parts.push(`Available tools: ${toolNames.join(', ')}`);
  }

  return parts.join('\n\n');
}

/**
 * Build the judge request for "choice" mode (per-tool decision)
 */
export function buildChoiceRequest(state: string, toolNames: string[]): JudgeRequest {
  return {
    state,
    questions: {
      decision: {
        type: 'choice',
        instructions: 'For each tool, decide whether to KEEP or DISCARD it based on relevance to the user\'s request. Return a probability for each criterion.',
        criteria: ['keep', 'discard'],
      },
    },
  };
}

/**
 * Build the judge request for "noul" mode (batch scoring)
 */
export function buildNoulRequest(state: string, toolNames: string[]): JudgeRequest {
  return {
    state,
    questions: {
      keep: {
        type: 'noul',
        instructions: 'Score each tool 0.0-1.0 for relevance to the user\'s request. Return a score for each tool name.',
      },
    },
  };
}

/**
 * Parse choice response and return tools to erase (below threshold)
 */
export function parseChoiceResponse(
  response: JudgeResponse,
  toolNames: string[],
  threshold: number,
): string[] {
  const answer = response.answer?.decision;
  if (!answer || answer.type !== 'choice') return [];

  const probs = answer.probabilities ?? {};
  const eraseNames: string[] = [];

  for (const name of toolNames) {
    const keepProb = probs[name] ?? probs[`keep:${name}`] ?? probs[`discard:${name}`] ?? 1.0;
    // If the response uses "discard" as the key, invert
    const discardProb = probs[`discard:${name}`] ?? (1 - keepProb);
    const finalKeepProb = probs[name] !== undefined ? probs[name] : (1 - discardProb);

    if (finalKeepProb < threshold) {
      eraseNames.push(name);
    }
  }

  return eraseNames;
}

/**
 * Parse noul response and return tools to erase (below threshold)
 */
export function parseNoulResponse(
  response: JudgeResponse,
  toolNames: string[],
  threshold: number,
): string[] {
  const answer = response.answer?.keep;
  if (!answer || answer.type !== 'noul') return [];

  const items = answer.items ?? {};
  const eraseNames: string[] = [];

  for (const name of toolNames) {
    const score = items[name];
    if (typeof score === 'number' && score < threshold) {
      eraseNames.push(name);
    }
  }

  return eraseNames;
}

/**
 * Call the judge sidecar with the given request
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

    const resp = await fetch(`${config.url}/judge`, {
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

    const data = await resp.json();
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
 * Main entry point: judge tools and return names to erase
 * Fails open — returns empty array on any error
 */
export async function judgeTools(
  body: Record<string, unknown>,
  proxyConfig: ProxyConfig,
  requestId: string,
): Promise<JudgeResult> {
  const sidecarConfig = proxyConfig.tool_judge_sidecar;
  if (!sidecarConfig?.url) {
    return { eraseNames: [], judgedNames: [], called: false };
  }

  const toolNames = extractToolNames(body);
  if (toolNames.length === 0) {
    return { eraseNames: [], judgedNames: [], called: false };
  }

  // Limit batch size
  const maxBatch = sidecarConfig.max_batch_tools ?? 50;
  const toolsToJudge = toolNames.slice(0, maxBatch);

  const config: JudgeSidecarConfig = {
    url: sidecarConfig.url,
    timeoutMs: sidecarConfig.timeout_ms ?? 50,
    threshold: sidecarConfig.threshold ?? 0.5,
    mode: sidecarConfig.mode ?? 'choice',
    apiKey: sidecarConfig.api_key,
    maxBatchTools: maxBatch,
  };

  const state = buildStateText(body, toolsToJudge);
  const request = config.mode === 'choice'
    ? buildChoiceRequest(state, toolsToJudge)
    : buildNoulRequest(state, toolsToJudge);

  logger.debug(requestId, `Calling tool judge sidecar (${config.mode}, ${toolsToJudge.length} tools)`);

  const response = await callJudgeSidecar(config, request, requestId);

  if (!response) {
    return {
      eraseNames: [],
      judgedNames: toolsToJudge,
      called: true,
      error: 'Sidecar call failed (timeout or error) — failing open',
    };
  }

  const eraseNames = config.mode === 'choice'
    ? parseChoiceResponse(response, toolsToJudge, config.threshold)
    : parseNoulResponse(response, toolsToJudge, config.threshold);

  logger.info(requestId, `Tool judge: ${toolsToJudge.length} tools judged, ${eraseNames.length} to erase (mode=${config.mode}, threshold=${config.threshold})`);

  return {
    eraseNames,
    judgedNames: toolsToJudge,
    rawResponse: response,
    called: true,
  };
}