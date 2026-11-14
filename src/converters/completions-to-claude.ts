/**
 * Converter: Chat Completions request body → Anthropic Messages request body.
 *
 * The Messages hop of the Completions intermediate: a client's own format is
 * converted to Completions first (`claude-to-openai.ts`, `gemini-to-openai.ts`),
 * then re-targeted here for an `anthropic-messages` upstream. One direction only —
 * the Messages *answer* comes back through `openai-to-claude.ts`.
 *
 * The two Completions-side readers this file shares with the Responses hop,
 * `openAIContentToText` and `completionsForcedToolName`, live in
 * `completions-to-responses.ts`.
 */

import { OpenAIContent, OpenAIMessage } from '../types/openai.js';
import { ValidationError } from '../utils/errors.js';
import { decodeDataUriOrRef } from './claude-to-gemini.js';
import { fetchImageAsInlineData } from '../utils/image-fetch.js';
import { isBlobRef, rebindBlobRef } from '../utils/blob-refs.js';
import { openAIContentToText, completionsForcedToolName } from './completions-to-responses.js';

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string' || value === '') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Convert an OpenAI message `content` value into the Claude representation:
 *   - string content returns as a string (preserves the common simple case).
 *   - array content with only text parts collapses to a joined string
 *     (matches prior behavior and keeps the wire shape minimal).
 *   - array content containing any `image_url` part returns Claude content
 *     blocks (`{type:'text'}` / `{type:'image', source:{type:'base64', ...}}`).
 *
 * `image_url` URLs are decoded via `decodeDataUri` for `data:` URIs and
 * `fetchImageAsInlineData` for http(s) (SSRF-guarded). Throws on any fetch /
 * decode failure (Rule #8 — Fail Loud, no placeholder image).
 */
async function openAIContentToClaudeStringOrBlocks(
  content: OpenAIContent | unknown,
): Promise<string | unknown[]> {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const blocks: Array<{ type: string; [k: string]: unknown }> = [];
  for (const part of content as Array<Record<string, unknown>>) {
    const pType = part.type;
    if (pType === 'text') {
      const text = part.text as string | undefined;
      if (typeof text === 'string' && text !== '') blocks.push({ type: 'text', text });
    } else if (pType === 'image_url') {
      const url: unknown = (part.image_url as Record<string, unknown> | undefined)?.url;
      if (typeof url !== 'string' && !isBlobRef(url)) continue;
      if (typeof url === 'string' && url === '') continue;
      const img = isBlobRef(url) || url.startsWith('data:')
        ? decodeDataUriOrRef(url)
        : await fetchImageAsInlineData(url);
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mime_type,
          data: isBlobRef(img.data) ? rebindBlobRef(img.data, 'claude-source-data', '') : img.data,
        },
      });
    }
    // Unknown part types (e.g. thinking) are skipped here — handled by caller.
  }

  // Collapse text-only arrays back to a string (matches prior wire shape).
  if (blocks.length === 0) return '';
  if (blocks.every(b => b.type === 'text')) {
    return (blocks as unknown as Array<{ text: string }>).map(b => b.text).join('');
  }
  return blocks;
}

/** Map a Completions `tool_choice` onto the Claude Messages vocabulary. */
function completionsToolChoiceToClaude(toolChoice: unknown): Record<string, unknown> | undefined {
  if (toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'none') return { type: 'none' };
  // Completions' "a tool call and no prose" is Claude's `any`.
  if (toolChoice === 'required') return { type: 'any' };
  const name = completionsForcedToolName(toolChoice);
  return name === undefined ? undefined : { type: 'tool', name };
}

/**
 * Convert an OpenAI Chat Completions body (model, messages, max_tokens, ...) to a
 * Claude Messages body. Used to route Gemini endpoints (interactions/generateContent)
 * through an anthropic-messages upstream.
 *
 * Async because array-form `content` with `image_url` parts pointing at http(s)
 * URLs requires a server-side fetch (SSRF-guarded; see `fetchImageAsInlineData`).
 * `data:` URIs are decoded synchronously via `decodeDataUri`.
 */
export async function completionsToClaudeBody(completions: Record<string, unknown>, model: string): Promise<Record<string, unknown>> {
  const messages = (completions.messages as OpenAIMessage[]) || [];
  // Claude carries one top-level `system`, not system turns inside `messages`, so
  // every system-level message — OpenAI's `developer` included — is merged into it
  // in document order, the same join `completionsToResponsesBody` applies to
  // `instructions`. Taking only the first one dropped the others in silence, and
  // two can arrive together: `convertResponsesToChatCompletions` prepends a system
  // message from `instructions` and maps every `developer` input item to role
  // `system`, so `/v1/responses` reaches this hop with a pair.
  const systemText = messages
    .filter(m => m.role === 'system' || m.role === 'developer')
    .map(m => openAIContentToText(m.content))
    .filter(text => text !== '')
    .join('\n');
  const otherMessages = messages.filter(m => m.role !== 'system' && m.role !== 'developer');

  // Group consecutive tool-role messages into a single user message with multiple
  // tool_result blocks — Claude requires all results in one message immediately
  // after the assistant turn that issued the tool_calls.
  const claudeMessages: unknown[] = [];
  let i = 0;
  while (i < otherMessages.length) {
    const m = otherMessages[i];
    const thinking = (m as unknown as Record<string, unknown>).reasoning_content as string | undefined;
    if (m.tool_calls) {
      const content: unknown[] = [];
      if (thinking) content.push({ type: 'thinking', thinking });
      content.push(...m.tool_calls.map(tc => ({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: parseJsonObject(tc.function.arguments),
      })));
      claudeMessages.push({ role: 'assistant', content });
      i++;
      // Collect all immediately following tool messages into one user message.
      const toolResults: unknown[] = [];
      while (i < otherMessages.length && otherMessages[i].role === 'tool') {
        const t = otherMessages[i];
        toolResults.push({ type: 'tool_result', tool_use_id: t.tool_call_id, content: t.content ?? '' });
        i++;
      }
      if (toolResults.length > 0) {
        claudeMessages.push({ role: 'user', content: toolResults });
      }
    } else if (m.role === 'tool') {
      // Orphaned tool message (no preceding tool_calls — should not happen, but be safe).
      claudeMessages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content ?? '' }] });
      i++;
    } else if (thinking) {
      // Thinking turn: emit a `thinking` block followed by text/image blocks.
      const textOrBlocks = await openAIContentToClaudeStringOrBlocks(m.content);
      const blocks = typeof textOrBlocks === 'string'
        ? [{ type: 'text', text: textOrBlocks }]
        : textOrBlocks;
      claudeMessages.push({ role: m.role, content: [{ type: 'thinking', thinking }, ...blocks] });
      i++;
    } else {
      const content = await openAIContentToClaudeStringOrBlocks(m.content);
      claudeMessages.push({ role: m.role, content });
      i++;
    }
  }

  const claudeBody: Record<string, unknown> = {
    model,
    messages: claudeMessages,
    // Legacy `max_tokens` wins when both names are present; `max_completion_tokens`
    // is the newer OpenAI spelling and is the only one some clients send.
    max_tokens: (completions.max_tokens as number | undefined)
      ?? (completions.max_completion_tokens as number | undefined)
      ?? 4096,
    stream: completions.stream === true,
  };

  // Omitted entirely when every system message was empty or absent, as the
  // sibling converter does with `if (instructions)`.
  if (systemText) claudeBody.system = systemText;
  if (completions.temperature !== undefined) claudeBody.temperature = completions.temperature;
  if (completions.top_p !== undefined) claudeBody.top_p = completions.top_p;
  if (completions.stop !== undefined) claudeBody.stop_sequences = Array.isArray(completions.stop) ? completions.stop : [completions.stop as string];

  // Structured output: Completions spells it `response_format`, the Messages API
  // `output_config.format`. Anthropic has no schema-less JSON mode — the format's
  // `type` is always `json_schema` and its `schema` is required — so a Completions
  // `json_object` (a valid JSON object, no declared shape) becomes the permissive
  // object schema, the closest expressible equivalent. `text` asks for the default
  // and an unmapped `type` stays unmapped, as in `completionsToResponsesBody`.
  const responseFormat = completions.response_format as Record<string, unknown> | undefined;
  if (responseFormat && typeof responseFormat === 'object') {
    if (responseFormat.type === 'json_object') {
      claudeBody.output_config = { format: { type: 'json_schema', schema: { type: 'object' } } };
    } else if (responseFormat.type === 'json_schema') {
      const jsonSchema = responseFormat.json_schema as Record<string, unknown> | undefined;
      const schema = jsonSchema?.schema;
      // `format.schema` is required. Sending the request without one would only
      // be rejected upstream with a less useful message, and dropping the field
      // would lose the client's guarantee without saying so (repo rule #8).
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        throw new ValidationError("response_format json_schema requires a 'json_schema.schema' object");
      }
      claudeBody.output_config = { format: { type: 'json_schema', schema } };
    }
  }

  if (completions.tools && Array.isArray(completions.tools) && (completions.tools as unknown[]).length > 0) {
    claudeBody.tools = (completions.tools as Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>).map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));

    // Gated on the tools above: Claude rejects a tool_choice with no tools.
    const toolChoice = completionsToolChoiceToClaude(completions.tool_choice);
    if (toolChoice !== undefined) claudeBody.tool_choice = toolChoice;
  }

  return claudeBody;
}
