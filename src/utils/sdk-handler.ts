/**
 * SDK handler utility for Claude Proxy v3
 *
 * Handles sdk:// URLs. The `chatjimmy` submodule that used to back these routes
 * has been removed, so sdk:// routes are still parsed and accepted by config
 * validation but every request fails loud at request time.
 */

import { Env, Logger } from '../types/shared.js';
import { ThinkingConversionOptions } from '../converters/claude-to-openai.js';
import { ClaudeProxyError } from './errors.js';

const SDK_UNAVAILABLE_MESSAGE =
  'sdk:// routes are no longer supported: the chatjimmy SDK was removed from this project. ' +
  'Point the model\'s base_url at an http(s) upstream instead.';

function throwSdkUnavailable(requestId: string, modelAlias?: string): never {
  throw new ClaudeProxyError(
    `${SDK_UNAVAILABLE_MESSAGE} (model: ${modelAlias ?? 'unknown'}, request: ${requestId})`,
    501,
    'not_implemented'
  );
}

/**
 * Check if target URL is an SDK URL (sdk://)
 */
export function isSdkUrl(targetUrl: string): boolean {
  return targetUrl.startsWith('sdk://');
}

/**
 * Handle SDK request for OpenAI-compatible mode.
 *
 * Kept as an explicit stub so the sdk:// route parses and fails loud (501)
 * rather than silently doing nothing.
 */
export async function handleSdkOpenAIRequest(
  request: Request,
  targetUrl: string,
  requestId: string,
  apiKey?: string,
  modelAlias?: string,
  logger?: Logger,
  env?: Env,
  requestBody?: Record<string, unknown>,
  outputFormat: 'openai' | 'claude' = 'openai',
  conversionOptions?: ThinkingConversionOptions
): Promise<Response> {
  void request; void targetUrl; void apiKey; void logger; void env;
  void requestBody; void outputFormat; void conversionOptions;
  throwSdkUnavailable(requestId, modelAlias);
}

/**
 * Handle SDK request for Anthropic-compatible mode.
 *
 * Kept as an explicit stub so the sdk:// route parses and fails loud (501)
 * rather than silently doing nothing.
 */
export async function handleSdkAnthropicRequest(
  request: Request,
  targetUrl: string,
  requestId: string,
  apiKey?: string,
  modelAlias?: string,
  logger?: Logger,
  env?: Env,
  requestBody?: Record<string, unknown>
): Promise<Response> {
  void request; void targetUrl; void apiKey; void logger; void env; void requestBody;
  throwSdkUnavailable(requestId, modelAlias);
}
