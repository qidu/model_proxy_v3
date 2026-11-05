/**
 * Validation utilities for Claude Proxy v3
 */

import { ClaudeMessagesRequest, ClaudeTokenCountingRequest, ClaudeContent, ThinkingConfigParam } from '../types/claude.js';
import { ValidationError } from './errors.js';
import { assertRefShape, isBlobRef } from './blob-refs.js';

// Default max image block data size: 10MB
const DEFAULT_IMAGE_DATA_MAX_SIZE = 10 * 1024 * 1024;

/**
 * The size of an inline `source.data` field: the character count of the base64 the
 * client sent, or the byte count a §5.3 shape-3 ref records for the payload it
 * stands in for.
 *
 * A ref is not a smaller spelling of the payload and cannot be measured as one —
 * `JSON.stringify(ref).length` would be its metadata's size — so the recorded
 * `size` is the only honest answer, and `assertRefShape` runs first because a
 * fraction or a missing `size` would silently make every bound below pass (§9.3).
 *
 * `undefined` means the field holds no inline payload at all, which is the case
 * each caller reports in its own words (an empty string is not a payload either,
 * matching what this check did before refs existed).
 */
function sourceDataSize(data: unknown): number | undefined {
  if (isBlobRef(data)) {
    assertRefShape(data);
    return data.size;
  }
  if (typeof data !== 'string' || data === '') {
    return undefined;
  }
  return data.length;
}

/**
 * Validate Claude messages request
 */
export function validateClaudeMessagesRequest(
  request: ClaudeMessagesRequest,
  modelId?: string,
  maxImageDataSize: number = DEFAULT_IMAGE_DATA_MAX_SIZE,
  interleavedThinking: boolean = false
): void {
  // Validate required fields
  if (!request.messages || !Array.isArray(request.messages)) {
    throw new ValidationError('messages field is required and must be an array');
  }

  if (request.messages.length === 0) {
    throw new ValidationError('messages array must not be empty');
  }

  // Validate messages content and limits
  if (request.messages.length > 100000) {
    throw new ValidationError('messages array cannot exceed 100,000 messages per request');
  }

  for (let i = 0; i < request.messages.length; i++) {
    validateClaudeMessage(request.messages[i], `messages[${i}]`, maxImageDataSize);
  }

  // Validate model
  if (!modelId && !request.model) {
    throw new ValidationError('Either model must be specified in URL or in request body');
  }

  // Validate max_tokens
  if (request.max_tokens !== undefined) {
    if (typeof request.max_tokens !== 'number') {
      throw new ValidationError('max_tokens must be a number');
    }
    if (request.max_tokens < 1) {
      throw new ValidationError('max_tokens must be at least 1');
    }
    if (request.max_tokens > 100000) {
      throw new ValidationError('max_tokens cannot exceed 100,000');
    }
  }

  // Validate temperature
  if (request.temperature !== undefined) {
    if (typeof request.temperature !== 'number') {
      throw new ValidationError('temperature must be a number');
    }
    if (request.temperature < 0 || request.temperature > 1) {
      throw new ValidationError('temperature must be between 0 and 1');
    }
  }

  // Validate top_p
  if (request.top_p !== undefined) {
    if (typeof request.top_p !== 'number') {
      throw new ValidationError('top_p must be a number');
    }
    if (request.top_p < 0 || request.top_p > 1) {
      throw new ValidationError('top_p must be between 0 and 1');
    }
  }

  // Validate top_k
  if (request.top_k !== undefined) {
    if (typeof request.top_k !== 'number') {
      throw new ValidationError('top_k must be a number');
    }
    if (request.top_k < 1 || request.top_k > 1000) {
      throw new ValidationError('top_k must be between 1 and 1000');
    }
  }

  // Validate thinking parameter
  if (request.thinking !== undefined) {
    request.thinking = clampThinkingBudget(request.thinking, request.max_tokens, interleavedThinking);
    validateThinkingConfig(request.thinking, 'thinking');
  }

  // Validate stop_sequences
  if (request.stop_sequences !== undefined) {
    if (!Array.isArray(request.stop_sequences)) {
      throw new ValidationError('stop_sequences must be an array');
    }
    for (let i = 0; i < request.stop_sequences.length; i++) {
      if (typeof request.stop_sequences[i] !== 'string') {
        throw new ValidationError(`stop_sequences[${i}] must be a string`);
      }
    }
  }

  // Validate metadata (optional, not in current Claude API spec but included for future compatibility)
  if ((request as any).metadata !== undefined) {
    if (typeof (request as any).metadata !== 'object' || (request as any).metadata === null) {
      throw new ValidationError('metadata must be an object');
    }
    if ((request as any).metadata.user_id !== undefined && typeof (request as any).metadata.user_id !== 'string') {
      throw new ValidationError('metadata.user_id must be a string');
    }
  }

  // Validate stream parameter
  if (request.stream !== undefined && typeof request.stream !== 'boolean') {
    throw new ValidationError('stream must be a boolean');
  }
}

/**
 * Validate Claude message
 */
export function validateClaudeMessage(
  message: any,
  context: string = 'message',
  maxImageDataSize: number = DEFAULT_IMAGE_DATA_MAX_SIZE
): void {
  if (!message || typeof message !== 'object') {
    throw new ValidationError(`${context} must be an object`);
  }

  // Validate role
  if (!message.role || typeof message.role !== 'string') {
    throw new ValidationError(`${context}.role is required and must be a string`);
  }

  const validRoles = ['user', 'assistant', 'system'];
  if (!validRoles.includes(message.role)) {
    throw new ValidationError(`${context}.role must be one of: ${validRoles.join(', ')}`);
  }

  // Validate content
  validateClaudeContent(message.content, `${context}.content`, maxImageDataSize);
}

/**
 * Validate Claude content
 */
export function validateClaudeContent(
  content: ClaudeContent,
  context: string = 'content',
  maxImageDataSize: number = DEFAULT_IMAGE_DATA_MAX_SIZE
): void {
  if (typeof content === 'string') {
    // Simple string content
    if (content.trim().length === 0) {
      throw new ValidationError(`${context} string must not be empty`);
    }
    return;
  }

  if (!Array.isArray(content)) {
    throw new ValidationError(`${context} must be a string or array of content blocks`);
  }

  if (content.length === 0) {
    throw new ValidationError(`${context} array must not be empty`);
  }

  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    validateClaudeContentBlock(block, `${context}[${i}]`, maxImageDataSize);
  }
}

/**
 * Validate Claude content block
 */
export function validateClaudeContentBlock(
  block: any,
  context: string = 'content block',
  maxImageDataSize: number = DEFAULT_IMAGE_DATA_MAX_SIZE
): void {
  if (!block || typeof block !== 'object') {
    throw new ValidationError(`${context} must be an object`);
  }

  if (!block.type || typeof block.type !== 'string') {
    throw new ValidationError(`${context}.type is required and must be a string`);
  }

  const validTypes = ['text', 'image', 'document', 'tool_use', 'tool_result', 'web_search_result', 'thinking'];
  if (!validTypes.includes(block.type)) {
    throw new ValidationError(`${context}.type must be one of: ${validTypes.join(', ')}`);
  }

  // Type-specific validation
  switch (block.type) {
    case 'text':
      if (block.text === undefined || typeof block.text !== 'string') {
        throw new ValidationError(`${context}.text is required for text blocks`);
      }
      break;

    case 'image':
      if (!block.source) {
        throw new ValidationError(`${context}.source is required for image blocks`);
      }
      if (typeof block.source !== 'object') {
        throw new ValidationError(`${context}.source must be an object`);
      }
      if (block.source.type !== 'base64' && block.source.type !== 'url') {
        throw new ValidationError(`${context}.source.type must be 'base64' or 'url'`);
      }
      if (block.source.type === 'base64') {
        if (!block.source.media_type || typeof block.source.media_type !== 'string') {
          throw new ValidationError(`${context}.source.media_type is required for base64 images`);
        }
        // §5.3 shape 3: the payload may be a ref, in which case `sourceDataSize`
        // reads the size the extraction recorded instead of the field's own.
        const dataSize = sourceDataSize(block.source.data);
        if (dataSize === undefined) {
          throw new ValidationError(`${context}.source.data is required for base64 images`);
        }
        if (dataSize > maxImageDataSize) {
          throw new ValidationError(`${context}.source.data exceeds maximum size of ${maxImageDataSize} bytes`);
        }
      } else if (block.source.type === 'url') {
        if (!block.source.url || typeof block.source.url !== 'string') {
          throw new ValidationError(`${context}.source.url is required for URL images`);
        }
        if (block.source.media_type && typeof block.source.media_type !== 'string') {
          throw new ValidationError(`${context}.source.media_type must be a string if provided`);
        }
      }
      break;

    case 'document':
      if (!block.source) {
        throw new ValidationError(`${context}.source is required for document blocks`);
      }
      if (typeof block.source !== 'object') {
        throw new ValidationError(`${context}.source must be an object`);
      }
      if (block.source.type !== 'base64' && block.source.type !== 'text') {
        throw new ValidationError(`${context}.source.type must be 'base64' or 'text'`);
      }
      if (!block.source.media_type || typeof block.source.media_type !== 'string') {
        throw new ValidationError(`${context}.source.media_type is required`);
      }
      // §5.3 shape 3: see the image branch — a ref stands in for the payload here too.
      if (sourceDataSize(block.source.data) === undefined) {
        throw new ValidationError(`${context}.source.data is required`);
      }
      break;

    case 'tool_use':
      if (!block.id || typeof block.id !== 'string') {
        throw new ValidationError(`${context}.id is required for tool_use blocks`);
      }
      if (!block.name || typeof block.name !== 'string') {
        throw new ValidationError(`${context}.name is required for tool_use blocks`);
      }
      if (block.input === undefined) {
        throw new ValidationError(`${context}.input is required for tool_use blocks`);
      }
      break;

    case 'tool_result':
      if (!block.tool_use_id || typeof block.tool_use_id !== 'string') {
        throw new ValidationError(`${context}.tool_use_id is required for tool_result blocks`);
      }
      if (block.content === undefined) {
        throw new ValidationError(`${context}.content is required for tool_result blocks`);
      }
      break;

    case 'thinking':
      if (block.thinking === undefined || typeof block.thinking !== 'string') {
        throw new ValidationError(`${context}.thinking is required for thinking blocks`);
      }
      break;

    case 'web_search_result':
      if (!block.search_query || typeof block.search_query !== 'string') {
        throw new ValidationError(`${context}.search_query is required for web_search_result blocks`);
      }
      if (!block.search_results || !Array.isArray(block.search_results)) {
        throw new ValidationError(`${context}.search_results is required and must be an array`);
      }
      break;
  }
}

/**
 * Clamp thinking.budget_tokens down to max_tokens when the budget would
 * otherwise exceed it. Returns the input unchanged when no clamping is
 * needed or when the input is not an enabled thinking config.
 *
 * Per the Claude API spec (docs/claude-extended-thinking.md):
 * - budget_tokens requires a minimum of 1,024 tokens
 * - budget_tokens must be less than max_tokens
 * - EXCEPTION: when using interleaved thinking with tools
 *   (anthropic-beta: interleaved-thinking-2025-05-14), budget_tokens may
 *   exceed max_tokens up to the full context window
 *
 * If max_tokens itself is below 1,024 and thinking is enabled with a budget,
 * no valid clamp exists — throws with a clear message.
 */
export function clampThinkingBudget(
  thinking: ThinkingConfigParam,
  maxTokens?: number,
  interleavedThinking: boolean = false
): ThinkingConfigParam {
  if (!thinking || typeof thinking !== 'object') return thinking;
  if (maxTokens === undefined) return thinking;

  const isEnabled = thinking.type === 'enabled' || thinking.type === true;
  if (!isEnabled) return thinking;
  if (typeof thinking.budget_tokens !== 'number') return thinking;
  if (thinking.budget_tokens <= maxTokens) return thinking;

  // Interleaved-thinking exception: budget may exceed max_tokens
  // (per docs/claude-extended-thinking.md:323)
  if (interleavedThinking) return thinking;

  // max_tokens < 1,024 cannot satisfy the thinking minimum budget.
  // Clamping here would produce an invalid budget that fails downstream validation.
  if (maxTokens < 1024) {
    throw new ValidationError(
      `thinking.budget_tokens cannot be clamped to max_tokens (${maxTokens}): max_tokens must be at least 1,024 when thinking is enabled`
    );
  }

  return { ...thinking, budget_tokens: maxTokens };
}

/**
 * Validate thinking configuration
 */
export function validateThinkingConfig(
  thinking: ThinkingConfigParam,
  context: string = 'thinking'
): void {
  if (!thinking || typeof thinking !== 'object') {
    throw new ValidationError(`${context} must be an object`);
  }

  if (thinking.type === undefined) {
    throw new ValidationError(`${context}.type is required`);
  }

  // Accept boolean values (true = enabled, false = disabled) in addition to string values
  const isValidType = (thinking.type === 'enabled' || thinking.type === 'adaptive') || thinking.type === 'disabled' ||
                     thinking.type === true || thinking.type === false;

  if (!isValidType) {
    throw new ValidationError(`${context}.type (${thinking.type}) must be 'enabled', 'disabled', true, or false`);
  }

  // Check if thinking is enabled (either string 'enabled' or boolean true)
  const isEnabled = thinking.type === 'enabled' || thinking.type === true;

  if (isEnabled && thinking.budget_tokens !== undefined) {
    if (typeof thinking.budget_tokens !== 'number') {
      throw new ValidationError(`${context}.budget_tokens must be a number`);
    }
    if (thinking.budget_tokens < 1024) {
      throw new ValidationError(`${context}.budget_tokens must be at least 1,024`);
    }
    if (thinking.budget_tokens > 100000) {
      throw new ValidationError(`${context}.budget_tokens cannot exceed 100,000`);
    }
  }
}

/**
 * Validate Claude token counting request
 */
export function validateClaudeTokenCountingRequest(
  request: ClaudeTokenCountingRequest,
  maxImageDataSize: number = DEFAULT_IMAGE_DATA_MAX_SIZE,
  interleavedThinking: boolean = false
): void {
  // Validate required fields
  if (!request.model) {
    throw new ValidationError('model field is required');
  }

  if (!request.messages || !Array.isArray(request.messages)) {
    throw new ValidationError('messages field is required and must be an array');
  }

  if (request.messages.length === 0) {
    throw new ValidationError('messages array must not be empty');
  }

  // Validate messages content and limits
  if (request.messages.length > 100000) {
    throw new ValidationError('messages array cannot exceed 100,000 messages per request');
  }

  for (let i = 0; i < request.messages.length; i++) {
    validateClaudeMessage(request.messages[i], `messages[${i}]`, maxImageDataSize);
  }

  // Validate thinking parameter
  if (request.thinking !== undefined) {
    request.thinking = clampThinkingBudget(request.thinking, (request as any).max_tokens, interleavedThinking);
    validateThinkingConfig(request.thinking, 'thinking');
  }
}

/**
 * Validate models request parameters
 */
export function validateModelsRequestParams(params: {
  after_id?: string;
  before_id?: string;
  limit?: number;
}): void {
  if (params.after_id !== undefined && typeof params.after_id !== 'string') {
    throw new ValidationError('after_id must be a string');
  }

  if (params.before_id !== undefined && typeof params.before_id !== 'string') {
    throw new ValidationError('before_id must be a string');
  }

  if (params.limit !== undefined) {
    if (typeof params.limit !== 'number') {
      throw new ValidationError('limit must be a number');
    }
    if (params.limit < 1 || params.limit > 1000) {
      throw new ValidationError('limit must be between 1 and 1000');
    }
  }
}

/**
 * Validate OpenAI chat completions request
 */
export function validateOpenAICompletionsRequest(request: Record<string, unknown>): void {
  if (!request.model || typeof request.model !== 'string') {
    throw new ValidationError('model is required and must be a string');
  }

  if (!request.messages || !Array.isArray(request.messages)) {
    throw new ValidationError('messages is required and must be an array');
  }

  if (request.messages.length === 0) {
    throw new ValidationError('messages array must not be empty');
  }

  for (let i = 0; i < request.messages.length; i++) {
    const msg = request.messages[i] as Record<string, unknown>;
    if (!msg || typeof msg !== 'object') {
      throw new ValidationError(`messages[${i}] must be an object`);
    }
    const validRoles = ['system', 'user', 'assistant', 'tool', 'developer'];
    if (!msg.role || typeof msg.role !== 'string') {
      throw new ValidationError(`messages[${i}].role is required and must be a string`);
    }
    if (!validRoles.includes(msg.role as string)) {
      throw new ValidationError(`messages[${i}].role must be one of: ${validRoles.join(', ')}`);
    }
    // content may be null on assistant messages that have tool_calls (OpenAI spec allows this).
    if (msg.content === undefined) {
      throw new ValidationError(`messages[${i}].content is required`);
    }
    if (msg.content !== null && typeof msg.content !== 'string' && !Array.isArray(msg.content)) {
      throw new ValidationError(`messages[${i}].content must be a string, array, or null`);
    }
  }

  if (request.max_tokens !== undefined) {
    if (typeof request.max_tokens !== 'number' || request.max_tokens < 1) {
      throw new ValidationError('max_tokens must be a positive number');
    }
  }

  if (request.temperature !== undefined) {
    if (typeof request.temperature !== 'number' || request.temperature < 0 || request.temperature > 2) {
      throw new ValidationError('temperature must be a number between 0 and 2');
    }
  }

  if (request.stream !== undefined && typeof request.stream !== 'boolean') {
    throw new ValidationError('stream must be a boolean');
  }
}

/**
 * Validate headers for API key or authorization
 */
export function validateAuthHeaders(headers: Record<string, string>): void {
  if (!headers['Authorization'] && !headers['x-api-key']) {
    throw new ValidationError('Either Authorization header or x-api-key header is required');
  }
}
