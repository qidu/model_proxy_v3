/**
 * Token counting utility
 *
 * Provides optional local token counting as an alternative to API-based counting.
 * This is useful for the /v1/messages/count_tokens endpoint when targeting
 * OpenAI-compatible APIs that don't have a native count_tokens endpoint.
 *
 * Configuration:
 * - LOCAL_TIKTOKEN: Set to "true"/"1" to enable local token counting via tiktoken
 * - TIKTOKEN_MODEL: Model name for tiktoken encoding (default: o200k_base)
 *   Supported models: cl100k_base, p50k_base, p50k_edit, r50k_base, gpt2, o200k_base
 * - TIKTOKEN_BPE_URL: URL to fetch tiktoken BPE data from (default: OpenAI's CDN)
 *   Note: bpeUrl parameter is currently not used with js-tiktoken
 *
 * An inline binary payload the spool extracted into a BlobRef (§5.2) is counted
 * by the §5.3 rule instead of as text: `Math.ceil(size / charactersPerToken)`,
 * the blob never read. See `countRefTokens` below.
 */

import { Tiktoken } from 'js-tiktoken/lite';
import o200k_base from 'js-tiktoken/ranks/o200k_base';
import cl100k_base from 'js-tiktoken/ranks/cl100k_base';
import p50k_base from 'js-tiktoken/ranks/p50k_base';
import p50k_edit from 'js-tiktoken/ranks/p50k_edit';
import r50k_base from 'js-tiktoken/ranks/r50k_base';
import gpt2 from 'js-tiktoken/ranks/gpt2';
import { ThinkingConfigParam } from '../types/claude.js';
import { assertRefShape, collectBlobRefs, isBlobRef, type BlobRef } from './blob-refs.js';

export interface TokenCountingOptions {
  /** Whether to use local token counting (default: false, use API) */
  useLocalCounting?: boolean;
  /** Characters per token estimate for local counting (default: 4) */
  charactersPerToken?: number;
  /** Whether to count whitespace tokens (default: true) */
  countWhitespace?: boolean;
  /** Custom Tiktoken instance for accurate counting */
  tokenizer?: Tiktoken | null;
}

/**
 * Default options
 */
const DEFAULT_OPTIONS: TokenCountingOptions = {
  useLocalCounting: false, // Default to API-based counting
  charactersPerToken: 4,
  countWhitespace: true,
  tokenizer: null,
};

// Cache for loaded tokenizer
let cachedTokenizer: Tiktoken | null = null;
let tokenizerModelName: string = '';

/**
 * Get or initialize the Tiktoken tokenizer
 */
export async function getTiktokenTokenizer(
  modelName: string = 'cl100k_base',
  bpeUrl?: string
): Promise<Tiktoken> {
  if (cachedTokenizer && tokenizerModelName === modelName) {
    return cachedTokenizer;
  }

  // Map model names to their corresponding encodings
  let encoding;
  switch (modelName) {
    case 'cl100k_base':
      encoding = cl100k_base;
      break;
    case 'p50k_base':
      encoding = p50k_base;
      break;
    case 'p50k_edit':
      encoding = p50k_edit;
      break;
    case 'r50k_base':
      encoding = r50k_base;
      break;
    case 'gpt2':
      encoding = gpt2;
      break;
    case 'o200k_base':
    default:
      encoding = o200k_base;
      break;
  }

  cachedTokenizer = new Tiktoken(encoding);
  tokenizerModelName = modelName;
  return cachedTokenizer!;
}

/**
 * Estimate token count for a text string using character-based approximation
 *
 * This is a simple estimation that works reasonably well for English text.
 * For more accurate counting, use tiktoken or similar libraries.
 *
 * @param text - The text to count tokens for
 * @param options - Counting options
 * @returns Estimated token count
 */
export function estimateTokenCount(
  text: string,
  options: TokenCountingOptions = DEFAULT_OPTIONS
): number {
  const { charactersPerToken = 4, countWhitespace } = { ...DEFAULT_OPTIONS, ...options };

  if (!text || text.length === 0) {
    return 0;
  }

  let content = text;

  // If not counting whitespace, remove extra whitespace
  if (!countWhitespace) {
    content = text.replace(/\s+/g, ' ').trim();
  }

  // Estimate tokens based on character count
  // Average English word is about 4.5 characters including space
  // This is a rough approximation suitable for estimation
  const estimatedTokens = Math.ceil(content.length / charactersPerToken);

  // Add overhead for special tokens (system prompt, role markers, etc.)
  // Roughly 3-5 tokens overhead per message
  const overheadTokens = 5;

  return estimatedTokens + overheadTokens;
}

/**
 * Count tokens in a text string using tiktoken (if available)
 *
 * @param text - The text to count tokens for
 * @param options - Counting options with tokenizer
 * @returns Token count
 */
export function countTokensWithTiktoken(
  text: string,
  options: TokenCountingOptions = DEFAULT_OPTIONS
): number {
  if (!text || text.length === 0) {
    return 0;
  }

  const tokenizer = options.tokenizer ?? null;
  if (!tokenizer) {
    // Fallback to estimation if no tokenizer available
    return estimateTokenCount(text, options);
  }

  // Use tiktoken to count actual tokens
  const tokens = tokenizer.encode(text);
  return tokens.length;
}

/**
 * Count tokens in a message object
 *
 * @param message - Message object with role and content
 * @param options - Counting options
 * @returns Token count for the message
 */
type CountableContentBlock = Record<string, any> & { type: string };

export function countMessageTokens(
  message: { role: string; content: string | CountableContentBlock[] },
  options: TokenCountingOptions = DEFAULT_OPTIONS
): number {
  let tokenCount = 0;
  const useTiktoken = options.tokenizer != null;

  // Add tokens for role
  const roleText = `role: ${message.role}`;
  if (useTiktoken) {
    tokenCount += countTokensWithTiktoken(roleText, options);
  } else {
    tokenCount += estimateTokenCount(roleText, options);
  }

  // Count content
  if (typeof message.content === 'string') {
    if (useTiktoken) {
      tokenCount += countTokensWithTiktoken(message.content, options);
    } else {
      tokenCount += estimateTokenCount(message.content, options);
    }
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      tokenCount += countContentBlockTokens(block, options);
    }
  }

  // Add token for content type indicator
  tokenCount += 2;

  return tokenCount;
}

/**
 * Count tokens in a list of messages
 *
 * @param messages - Array of messages
 * @param options - Counting options
 * @returns Total token count
 */
export function countMessagesTokens(
  messages: Array<{ role: string; content: string | CountableContentBlock[] }>,
  options: TokenCountingOptions = DEFAULT_OPTIONS
): number {
  let totalTokens = 0;

  for (const message of messages) {
    totalTokens += countMessageTokens(message, options);
  }

  // Add tokens for message separators
  totalTokens += 3;

  return totalTokens;
}

/**
 * Count tokens in system prompt
 *
 * @param system - System prompt (string or array of text blocks)
 * @param options - Counting options
 * @returns Token count for system prompt
 */
export function countSystemTokens(
  system: string | CountableContentBlock[],
  options: TokenCountingOptions = DEFAULT_OPTIONS
): number {
  if (!system) {
    return 0;
  }

  const useTiktoken = options.tokenizer != null;

  if (typeof system === 'string') {
    if (useTiktoken) {
      return countTokensWithTiktoken(system, options);
    }
    return estimateTokenCount(system, options);
  }

  let tokenCount = 0;
  for (const block of system) {
    tokenCount += countContentBlockTokens(block, options);
  }

  return tokenCount;
}

function countContentBlockTokens(block: CountableContentBlock, options: TokenCountingOptions): number {
  switch (block.type) {
    case 'text':
      return block.text ? countStringTokens(block.text, options) : 0;
    case 'tool_result': {
      let content = `tool_result: ${block.tool_use_id ?? ''}`;
      if (typeof block.content === 'string') {
        content += `\n${block.content}`;
        return countStringTokens(content, options);
      }
      if (Array.isArray(block.content)) {
        return countStringTokens(content, options) + block.content.reduce((sum: number, nested: CountableContentBlock) => sum + countContentBlockTokens(nested, options), 0);
      }
      return countStringTokens(`${content}\n${JSON.stringify(block.content ?? '')}`, options);
    }
    case 'tool_use':
      return countStringTokens(`tool_use: ${block.id ?? ''}\nname: ${block.name ?? ''}\ninput: ${JSON.stringify(block.input ?? {})}`, options);
    case 'image': {
      const ref = inlinePayloadRef(block);
      if (ref) return countRefTokens(ref, options);
      const source = block.source ?? {};
      return countStringTokens(`image: ${source.type ?? ''}\nmedia_type: ${source.media_type ?? ''}\nurl: ${source.url ?? ''}\ndata: ${source.data ?? ''}`, options) + 20;
    }
    case 'document': {
      const ref = inlinePayloadRef(block);
      if (ref) return countRefTokens(ref, options);
      const source = block.source ?? {};
      return countStringTokens(`document: ${block.title ?? ''}\nmedia_type: ${source.media_type ?? ''}\ntype: ${source.type ?? ''}\ndata: ${source.data ?? ''}`, options) + 10;
    }
    case 'thinking':
      return countStringTokens(`thinking: ${block.thinking ?? ''}\nsignature: ${block.signature ?? ''}`, options);
    case 'web_search_result':
      return countStringTokens(`web_search_result: ${JSON.stringify(block)}`, options);
    default: {
      // A block with no Claude `type` discriminator — a Chat `image_url`, a Gemini
      // `inline_data`, a Responses `input_image`/`input_file`/`inline` — is counted
      // by its JSON text, which measures the ref's *metadata object* instead of the
      // payload it stands for. So every ref it holds contributes the payload's own
      // §5.3 approximation as well: without that, the payload would count as
      // nothing (the invisible undercount §9.3 rejects, and one `estimateInputTokens`
      // would have turned into a zero for the whole request).
      //
      // The block's own few tokens of JSON stay in — the one place this differs from
      // the `image`/`document` branches, which drop every fixed cost. A malformed ref
      // still fails the count rather than inflating it: `countRefTokens` asserts the
      // shape first (repo rule #8).
      let tokens = countStringTokens(JSON.stringify(block), options);
      for (const ref of collectBlobRefs(block)) {
        tokens += countRefTokens(ref, options);
      }
      return tokens;
    }
  }
}

/**
 * The §5.3 contribution of one extracted binary payload: exactly
 * `Math.ceil(base64CharLength / charactersPerToken)` and nothing else.
 *
 * The base64 character count is the ref's recorded `size` — base64 is ASCII, so
 * the blob's byte length *is* its character count — and the blob is deliberately
 * never read: reading it to tokenize would defeat the extraction that produced
 * the ref. The tokenizer is skipped for the same reason, and every fixed block
 * cost is dropped: field labels, media/source type, the `data:` prefix, and the
 * former image/document `+20`/`+10` overhead. So this is an approximation that
 * need not match what the same body counted inline (§5.3 accepts that, and
 * upstream-reported usage wins when it is available).
 *
 * `assertRefShape` runs before the arithmetic: a ref whose `size` is missing or
 * fractional would turn the whole request's count into `NaN` in silence, which is
 * the miscount §9.3 rejects (repo rule #8).
 */
function countRefTokens(ref: BlobRef, options: TokenCountingOptions): number {
  assertRefShape(ref);
  const { charactersPerToken = 4 } = { ...DEFAULT_OPTIONS, ...options };
  return Math.ceil(ref.size / charactersPerToken);
}

/**
 * The ref standing in for a Claude block's inline payload, when the spool
 * extracted it (§5.4): `source.data` on an `image` or `document` block.
 *
 * Without this the ref would be interpolated into the label text — `data:
 * [object Object]` — and the payload would be counted as nothing: a small,
 * invisible undercount of exactly the kind §9.3 rules out. These two are the
 * positions this estimator can name by hand, because they are the only §5.4
 * allowlisted ones that are Claude content blocks; every other allowlisted
 * position belongs to a Chat, Gemini or Responses shape, whose blocks reach the
 * `default` branch above and are counted there by a walk of their own refs.
 */
function inlinePayloadRef(block: CountableContentBlock): BlobRef | undefined {
  const source = block.source;
  if (!source || typeof source !== 'object') return undefined;
  const data = (source as Record<string, unknown>).data;
  return isBlobRef(data) ? data : undefined;
}

/**
 * Helper function to count tokens with appropriate method
 */
function countStringTokens(text: string, options: TokenCountingOptions): number {
  const useTiktoken = options.tokenizer != null;
  if (useTiktoken) {
    return countTokensWithTiktoken(text, options);
  }
  return estimateTokenCount(text, options);
}

/**
 * Main function to count tokens in a Claude-style request
 *
 * @param requestBody - Request body with model, messages, system, tools, etc.
 * @param options - Counting options
 * @returns Estimated input token count
 */
export function countClaudeRequestTokens(
  requestBody: {
    model?: string;
    messages: Array<{ role: string; content: string | CountableContentBlock[] }>;
    system?: string | CountableContentBlock[];
    tools?: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>;
    tool_choice?: { type: string; name?: string };
    thinking?: ThinkingConfigParam;
  },
  options: TokenCountingOptions = DEFAULT_OPTIONS
): number {
  let totalTokens = 0;
  const useTiktoken = options.tokenizer != null;

  // Count model name tokens (usually 1-2)
  if (requestBody.model) {
    totalTokens += countStringTokens(requestBody.model, options) + 1;
  }

  // Count system prompt tokens
  if (requestBody.system) {
    totalTokens += countSystemTokens(requestBody.system, options);
  }

  // Count messages tokens
  totalTokens += countMessagesTokens(requestBody.messages, options);

  // Estimate tool definition tokens
  if (requestBody.tools && requestBody.tools.length > 0) {
    for (const tool of requestBody.tools) {
      let toolContent = `tool: ${tool.name}`;
      if (tool.description) {
        toolContent += `\ndescription: ${tool.description}`;
      }
      if (tool.input_schema) {
        toolContent += `\nparameters: ${JSON.stringify(tool.input_schema)}`;
      }
      totalTokens += countStringTokens(toolContent, options) + 3;
    }
    // Add overhead for tools array
    totalTokens += 5;
  }

  // Estimate tool_choice tokens
  if (requestBody.tool_choice) {
    if (requestBody.tool_choice.type === 'tool' && requestBody.tool_choice.name) {
      totalTokens += countStringTokens(`tool_choice: ${requestBody.tool_choice.name}`, options) + 2;
    } else {
      totalTokens += countStringTokens(`tool_choice: ${requestBody.tool_choice.type}`, options) + 2;
    }
  }

  // Estimate thinking config tokens
  if (requestBody.thinking) {
    // Convert boolean values to string equivalents for token counting
    const thinkingType = requestBody.thinking.type === true ? 'enabled' :
                        requestBody.thinking.type === false ? 'disabled' :
                        requestBody.thinking.type as string;
    totalTokens += countStringTokens(`thinking: ${thinkingType}`, options) + 2;
    if ('budget_tokens' in requestBody.thinking && requestBody.thinking.budget_tokens) {
      totalTokens += countStringTokens(`budget: ${requestBody.thinking.budget_tokens}`, options);
    }
  }

  return totalTokens;
}

/**
 * Get local token counting configuration from environment
 */
export function getLocalTokenCountingConfig(env?: Record<string, string>): {
  enabled: boolean;
  useTiktoken: boolean;
  modelName: string;
  bpeUrl?: string;
} {
  // Check for environment variable
  // In Cloudflare Workers, env is passed via the second parameter
  // Otherwise fall back to globalThis.process.env for local development
  const envVars = env || (typeof globalThis !== 'undefined' && (globalThis as any).process?.env ? (globalThis as any).process.env as Record<string, string> : {});

  const enabled = envVars.LOCAL_TIKTOKEN === 'true' || envVars.LOCAL_TIKTOKEN === '1';

  // Tiktoken options
  const useTiktoken = enabled;
  const modelName = envVars.TIKTOKEN_MODEL || 'o200k_base';
  const bpeUrl = envVars.TIKTOKEN_BPE_URL;

  return {
    enabled,
    useTiktoken,
    modelName,
    bpeUrl,
  };
}
