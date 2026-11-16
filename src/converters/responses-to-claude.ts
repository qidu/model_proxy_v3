/**
 * Direct OpenAI Responses → Claude Messages response converter.
 *
 * This is the response half of the `/v1/messages` → `openai-responses` pair. The
 * route used to synthesize a Chat Completions response from the Responses `output`
 * and hand that to `convertOpenAIToClaudeResponse`, which cost the reasoning items
 * (`reasoning` has no Completions position, so thinking arrived as nothing at all)
 * and reported a `refusal` part as plain text.
 *
 * Conventions this mirrors rather than reinvents:
 *
 * - A thinking block needs a `signature`, but a non-Anthropic upstream cannot issue
 *   one, so `SYNTHETIC_THINKING_SIGNATURE` is used, exactly as
 *   `convertOpenAIToClaudeResponse` does (`openai-to-claude.ts:19`).
 * - Usage goes through `extractTokenCounts`, handed a *normalized* usage object, so
 *   the local-token-counting fallback and the cache-read field keep working.
 * - `thinking.signature` / `reasoning.encrypted_content` are provider-specific
 *   ciphertext and are not mapped to each other; a blob that arrives is reported
 *   rather than presented as a signature.
 */

import type { ClaudeContentBlock, ClaudeMessagesResponse } from '../types/claude.js';
import type { Logger } from '../types/shared.js';
import { stringify } from '../utils/stringify.js';
import { extractTokenCounts, SYNTHETIC_THINKING_SIGNATURE, type TokenCountingConfig } from './openai-to-claude.js';
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

function warn(options: ConversionOptions | undefined, message: string): void {
  options?.logger?.warn(options.requestId ?? '', `[responses->claude] ${message}`);
}

/** The reasoning text of an item, from whichever of the two declared carriers holds it. */
export function responsesReasoningText(item: Record<string, unknown>): string {
  const parts = [
    ...(Array.isArray(item.summary) ? item.summary : []),
    ...(Array.isArray(item.content) ? item.content : []),
  ];
  return parts.map(asRecord)
    .filter(part => part?.type === 'summary_text' || part?.type === 'reasoning_text')
    .map(part => typeof part?.text === 'string' ? part.text : '')
    .join('');
}

/**
 * The Responses usage object re-spelled as the one `extractTokenCounts` reads.
 * Its cache field is `input_tokens_details.cached_tokens` here, which that function
 * already looks for, so only the two totals need renaming.
 */
function normalizedUsage(usage: unknown): Record<string, unknown> | undefined {
  const record = asRecord(usage);
  if (!record) return undefined;
  return {
    prompt_tokens: record.input_tokens,
    completion_tokens: record.output_tokens,
    prompt_tokens_details: asRecord(record.input_tokens_details),
  };
}

export async function responsesToClaudeResponse(
  response: Record<string, unknown>,
  model: string,
  requestId: string,
  requestBody?: Record<string, any>,
  config?: TokenCountingConfig,
  options?: ConversionOptions,
): Promise<ClaudeMessagesResponse> {
  const contentBlocks: ClaudeContentBlock[] = [];
  let refusal = '';

  for (const [index, value] of (Array.isArray(response.output) ? response.output : []).entries()) {
    const item = asRecord(value);
    if (!item) {
      warn(options, `output[${index}] is not an object; dropped`);
      continue;
    }

    if (item.type === 'message') {
      for (const partValue of Array.isArray(item.content) ? item.content : []) {
        const part = asRecord(partValue);
        if (part?.type === 'output_text' && typeof part.text === 'string') {
          contentBlocks.push({ type: 'text', text: part.text });
        } else if (typeof part?.refusal === 'string' && part.refusal !== '') {
          // Messages has no refusal block: presenting the withheld answer as a text
          // block would be a different answer than the upstream gave. It is carried
          // out on `stop_reason` instead, the same way the Completions hop reports a
          // policy block (`openai-to-claude.ts:41`).
          refusal += part.refusal;
        }
      }
      continue;
    }

    if (item.type === 'reasoning') {
      const text = responsesReasoningText(item);
      if (text !== '') {
        contentBlocks.push({ type: 'thinking', thinking: text, signature: SYNTHETIC_THINKING_SIGNATURE });
      } else if (item.encrypted_content !== undefined && item.encrypted_content !== null) {
        // An encrypted-only reasoning item: the ciphertext is the upstream's, not
        // Anthropic's, so there is no thinking text to show and no valid signature
        // to synthesize one from.
        warn(options, `output[${index}] reasoning carries only encrypted_content, which is provider-specific; no thinking block was invented`);
      }
      continue;
    }

    if (item.type === 'function_call') {
      const id = typeof item.call_id === 'string' && item.call_id !== ''
        ? item.call_id
        : typeof item.id === 'string' && item.id !== '' ? item.id : `call_${index}`;
      if (typeof item.name !== 'string' || item.name === '') {
        warn(options, `output[${index}] function_call ${id} has no name; dropped`);
        continue;
      }
      contentBlocks.push({
        type: 'tool_use',
        id,
        name: item.name,
        input: parseToolArguments(item.arguments),
      });
      continue;
    }

    // Server-side tool traffic the Responses API can report and Messages cannot
    // project: a Claude client reads its own server-tool results as
    // `web_search_tool_result` / `mcp_tool_use` blocks, and the Responses items
    // declare different fields (`action`/`status`, not a query and its results), so
    // there is nothing faithful to build. Reported by kind, never silently dropped.
    warn(options, `output[${index}] type ${stringify(item.type)} has no Claude Messages projection; dropped`);
  }

  if (refusal !== '') {
    warn(options, `the upstream refused the request; reported as stop_reason "refusal" rather than as answer text`);
  }

  const hasToolUse = contentBlocks.some(block => block.type === 'tool_use');
  const status = typeof response.status === 'string' ? response.status : undefined;
  const incompleteReason = asRecord(response.incomplete_details)?.reason;
  let stopReason: string | null;
  if (status === 'incomplete') {
    if (incompleteReason === 'content_filter') {
      stopReason = 'refusal';
    } else {
      stopReason = 'max_tokens';
      if (typeof incompleteReason === 'string' && incompleteReason !== 'max_output_tokens') {
        warn(options, `incomplete reason ${stringify(incompleteReason)} has no Messages equivalent; reported as "max_tokens"`);
      }
    }
  } else if (status === 'failed') {
    const message = asRecord(response.error)?.message;
    warn(options, `the upstream reported a failed response${typeof message === 'string' ? `: ${message}` : ''}; its output is being returned as-is`);
    stopReason = refusal !== '' ? 'refusal' : hasToolUse ? 'tool_use' : 'end_turn';
  } else if (refusal !== '') {
    stopReason = 'refusal';
  } else {
    stopReason = hasToolUse ? 'tool_use' : 'end_turn';
  }

  return {
    id: typeof response.id === 'string' && response.id !== '' ? response.id : requestId,
    type: 'message',
    role: 'assistant',
    model,
    content: contentBlocks,
    stop_reason: stopReason,
    // Always null, for the same reason the Completions converter gives: the wire
    // format never reports which sequence matched, so there is nothing to name.
    stop_sequence: null,
    usage: await extractTokenCounts(normalizedUsage(response.usage), requestBody, config),
  };
}
