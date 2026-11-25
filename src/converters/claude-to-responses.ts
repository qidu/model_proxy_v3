/**
 * Direct Claude Messages → OpenAI Responses request converter.
 *
 * This is the request half of the `/v1/messages` → `openai-responses` pair. The
 * route used to reach the Responses API through Chat Completions
 * (`convertClaudeToOpenAIRequest` → `completionsToResponsesBody`), and the
 * intermediate cost two things a direct converter keeps:
 *
 * - **Claude's server-tool family.** `mcp_servers` is carried to the Responses
 *   `mcp` tool, whose fields line up (`name` → `server_label`, `url` →
 *   `server_url`, `authorization_token` → `headers.Authorization`,
 *   `tool_configuration.allowed_tools` → `allowed_tools`). Completions spells
 *   function tools only, so the bridge had nowhere to put it.
 * - **`document` blocks.** `claude-to-openai.ts:82` skips them by name, so the
 *   bridged route dropped a client's PDF before it was ever sent. Here they
 *   become Responses `input_file` items (pinned as a drop by
 *   `tests/unit/request-ref-matrix.test.ts`).
 *
 * It also keeps `tools[].strict`, which both hops of the bridge dropped although
 * both target formats declare it.
 *
 * What it deliberately does **not** do: invent a mapping for Claude's
 * `thinking.signature`. Anthropic's signature is verified by Anthropic, Responses'
 * `reasoning.encrypted_content` is issued and verified by the Responses upstream,
 * and the two are not interchangeable — the repo's convention is to refuse the
 * mapping rather than guess (`responses-to-interactions.ts:99`,
 * `interactions-to-responses.ts:107`). Thinking *text* still round-trips, and a
 * signature the client sent is reported as dropped rather than passed off as
 * carried (rule #8).
 */

import type { Logger } from '../types/shared.js';
import type { ClaudeMessagesRequest, ClaudeTool, ClaudeMcpServer } from '../types/claude.js';
import { isBlobRef, rebindBlobRef } from '../utils/blob-refs.js';
import { ValidationError } from '../utils/errors.js';
import { stringify } from '../utils/stringify.js';
import { budgetToReasoningEffort, type ThinkingConversionOptions } from './claude-to-openai.js';

interface ConversionOptions {
  logger?: Logger;
  requestId?: string;
  systemMessagesAsDeveloper?: boolean;
  /** Thinking-budget → reasoning-effort thresholds, as the config declares them. */
  conversion?: ThinkingConversionOptions;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function warn(options: ConversionOptions | undefined, message: string): void {
  options?.logger?.warn(options.requestId ?? '', `[claude->responses] ${message}`);
}

/**
 * A base64 data URI for an inline payload, keeping a spool ref a ref: the ref is
 * rebound to the Responses input position with the prefix the payload will need
 * when it is finally expanded, so a streamed egress still sends one chunk per
 * blob instead of materializing the image here (§5.3/§5.4).
 */
function dataUri(
  data: unknown,
  mimeType: unknown,
  position: string,
  kind: 'responses-input-image' | 'responses-input-file',
): string | ReturnType<typeof rebindBlobRef> {
  const mime = typeof mimeType === 'string' && mimeType !== '' ? mimeType : 'application/octet-stream';
  const prefix = `data:${mime};base64,`;
  if (isBlobRef(data)) return rebindBlobRef(data, kind, prefix);
  if (typeof data !== 'string' || data === '') throw new ValidationError(`${position} requires non-empty base64 data`);
  return `${prefix}${data}`;
}

function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

/**
 * The `instructions` string for a Claude `system` field, in either spelling.
 * A non-text system block has no equivalent here, so it is reported rather than
 * dropped into a quietly different request (rule #8).
 */
function systemToInstructions(system: unknown, options?: ConversionOptions): string | undefined {
  if (typeof system === 'string') return system === '' ? undefined : system;
  if (!Array.isArray(system)) return undefined;
  const texts: string[] = [];
  for (const [index, value] of system.entries()) {
    const block = asRecord(value);
    if (!block) throw new ValidationError(`system[${index}] must be an object`);
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
      continue;
    }
    warn(options, `system[${index}] type ${stringify(block.type)} has no Responses instructions equivalent; dropped`);
  }
  const joined = texts.join('\n');
  return joined === '' ? undefined : joined;
}

/** A `tool_result` block's content, as the single string a `function_call_output` item carries. */
function toolResultOutput(block: Record<string, unknown>, at: string, options?: ConversionOptions): string {
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    // Same choice the Completions→Responses hop makes for an object-valued result:
    // serialize rather than collapse to '', so a structured answer survives.
    return stringify(block.content);
  }
  if (block.content === undefined || block.content === null) return '';
  if (block.is_error === true) {
    warn(options, `${at} tool_result is_error has no function_call_output equivalent; the failure is carried by the content only`);
  }
  return stringify(block.content);
}

/**
 * Turn one Claude message's content into Responses input items.
 *
 * Text and image parts accumulate into a single `message` item; a part that owns
 * its own item (`tool_use`, `tool_result`, `thinking`) flushes that item first, so
 * the upstream sees the same order the client wrote. That ordering is what the
 * Responses API requires: a `reasoning` item must precede the `function_call` it
 * explains, and a `function_call_output` must follow its `function_call`.
 */
function messageToItems(
  message: Record<string, unknown>,
  at: string,
  options?: ConversionOptions,
): Array<Record<string, unknown>> {
  const role = message.role === 'assistant' ? 'assistant' : 'user';
  const partType = role === 'assistant' ? 'output_text' : 'input_text';
  const items: Array<Record<string, unknown>> = [];
  let content: Array<Record<string, unknown>> = [];
  const flush = (): void => {
    if (content.length === 0) return;
    items.push({ type: 'message', role, content });
    content = [];
  };

  const contentOrText = message.content;
  if (typeof contentOrText === 'string') {
    if (contentOrText !== '') content.push({ type: partType, text: contentOrText });
    flush();
    return items;
  }
  if (!Array.isArray(contentOrText)) throw new ValidationError(`${at}.content must be a string or an array of content blocks`);

  for (const [index, value] of contentOrText.entries()) {
    const block = asRecord(value);
    if (!block) throw new ValidationError(`${at}.content[${index}] must be an object`);
    const where = `${at}.content[${index}]`;

    if (block.type === 'text' && typeof block.text === 'string') {
      content.push({ type: partType, text: block.text });
      continue;
    }

    if (block.type === 'image') {
      const source = asRecord(block.source);
      if (!source) throw new ValidationError(`${where}.source is required`);
      if (role === 'assistant') {
        warn(options, `${where} image has no Responses assistant-input position; dropped`);
        continue;
      }
      if (source.type === 'url' && typeof source.url === 'string') {
        content.push({ type: 'input_image', image_url: source.url });
      } else if (source.type === 'base64') {
        content.push({ type: 'input_image', image_url: dataUri(source.data, source.media_type, `${where}.source.data`, 'responses-input-image') });
      } else {
        warn(options, `${where}.source.type ${stringify(source.type)} has no Responses input_image equivalent; dropped`);
      }
      continue;
    }

    if (block.type === 'document') {
      const source = asRecord(block.source);
      if (!source) throw new ValidationError(`${where}.source is required`);
      const filename = typeof block.title === 'string' && block.title !== '' ? block.title : 'document.pdf';
      if (role === 'assistant') {
        warn(options, `${where} document has no Responses assistant-input position; dropped`);
      } else if (source.type === 'url' && typeof source.url === 'string') {
        content.push({ type: 'input_file', file_url: source.url, filename });
      } else if (source.type === 'base64') {
        content.push({
          type: 'input_file',
          file_data: dataUri(source.data, source.media_type ?? 'application/pdf', `${where}.source.data`, 'responses-input-file'),
          filename,
        });
      } else if (source.type === 'text' && typeof source.data === 'string') {
        // `file_data` carries base64; encode the text as UTF-8 before base64 so
        // non-Latin-1 documents do not fail in `btoa`.
        content.push({ type: 'input_file', file_data: `data:text/plain;base64,${base64Utf8(source.data)}`, filename });
      } else {
        warn(options, `${where}.source.type ${stringify(source.type)} has no Responses input_file equivalent; dropped`);
      }
      continue;
    }

    if (block.type === 'tool_use') {
      if (typeof block.id !== 'string' || block.id === '' || typeof block.name !== 'string' || block.name === '') {
        throw new ValidationError(`${where} tool_use requires id and name`);
      }
      flush();
      items.push({
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: stringify(block.input ?? {}),
      });
      continue;
    }

    if (block.type === 'tool_result') {
      if (typeof block.tool_use_id !== 'string' || block.tool_use_id === '') {
        throw new ValidationError(`${where} tool_result requires tool_use_id`);
      }
      flush();
      items.push({
        type: 'function_call_output',
        call_id: block.tool_use_id,
        output: toolResultOutput(block, where, options),
      });
      continue;
    }

    if (block.type === 'thinking') {
      flush();
      if (typeof block.thinking === 'string' && block.thinking !== '') {
        // `content`/`reasoning_text` is the spelling this repo replays *input*
        // reasoning with (`completions-to-responses.ts:392`, `:451`); `summary` is
        // the summary-delta carrier the upstream sends, not the replay form.
        items.push({ type: 'reasoning', content: [{ type: 'reasoning_text', text: block.thinking }] });
      }
      if (typeof block.signature === 'string' && block.signature !== '') {
        warn(options, `${where} thinking.signature is provider-specific and is not mapped to Responses reasoning.encrypted_content; dropped`);
      }
      continue;
    }

    if (block.type === 'redacted_thinking') {
      flush();
      warn(options, `${where} redacted_thinking is provider-specific ciphertext with no Responses equivalent; dropped`);
      continue;
    }

    warn(options, `${where} type ${stringify(block.type)} has no Responses item of its own; dropped`);
  }

  flush();
  return items;
}

/** Claude's declared tools and MCP connectors, in the one `tools[]` array Responses expects. */
function responseTools(
  tools: unknown,
  mcpServers: unknown,
  options?: ConversionOptions,
): Array<Record<string, unknown>> {
  const converted: Array<Record<string, unknown>> = [];
  for (const [index, value] of (Array.isArray(tools) ? tools : []).entries()) {
    const tool = asRecord(value) as (ClaudeTool & Record<string, unknown>) | undefined;
    if (!tool || typeof tool.name !== 'string' || tool.name === '') {
      throw new ValidationError(`tools[${index}] requires a name`);
    }
    converted.push({
      type: 'function',
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      parameters: tool.input_schema ?? { type: 'object', properties: {} },
      // Declared by both formats, dropped by both hops of the old bridge.
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    });
  }
  for (const [index, value] of (Array.isArray(mcpServers) ? mcpServers : []).entries()) {
    const server = asRecord(value) as (ClaudeMcpServer & Record<string, unknown>) | undefined;
    if (!server || typeof server.url !== 'string' || server.url === '') {
      throw new ValidationError(`mcp_servers[${index}] requires a url`);
    }
    // `server_label` is the only required field besides `type`, and Responses has
    // no separate "name", so the connector's name is the label it will be called by.
    const label = typeof server.name === 'string' && server.name !== '' ? server.name : server.url;
    const headers = typeof server.authorization_token === 'string' && server.authorization_token !== ''
      ? { Authorization: server.authorization_token }
      : undefined;
    const allowed = asRecord(server.tool_configuration)?.allowed_tools;
    if (asRecord(server.tool_configuration)?.enabled === false) {
      // "Disable this connector" has no Responses spelling: an `mcp` tool that is
      // declared is offered. Sending nothing is the closest faithful reading.
      warn(options, `mcp_servers[${index}] tool_configuration.enabled=false has no Responses equivalent; the connector is not declared`);
      continue;
    }
    converted.push({
      type: 'mcp',
      server_label: label,
      server_url: server.url,
      ...(headers !== undefined ? { headers } : {}),
      ...(Array.isArray(allowed) && allowed.length > 0 ? { allowed_tools: allowed.filter(name => typeof name === 'string') } : {}),
    });
  }
  return converted;
}

/** Claude's `tool_choice` + `disable_parallel_tool_use` → the Responses pair. */
function responseToolChoice(toolChoice: unknown, hasTools: boolean): unknown {
  const choice = asRecord(toolChoice);
  if (!choice || !hasTools) return undefined;
  if (choice.type === 'none') return 'none';
  if (choice.type === 'auto') return 'auto';
  // `any` is "must call some tool", which is Responses' `required`.
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool') {
    if (typeof choice.name !== 'string' || choice.name === '') {
      throw new ValidationError('tool_choice.type "tool" requires a name');
    }
    return { type: 'function', name: choice.name };
  }
  throw new ValidationError(`tool_choice type ${stringify(choice.type)} has no Responses equivalent`);
}

export function claudeToResponsesBody(
  request: ClaudeMessagesRequest,
  model: string,
  options?: ConversionOptions,
): Record<string, unknown> {
  const input: Array<Record<string, unknown>> = [];
  for (const [index, message] of (Array.isArray(request.messages) ? request.messages : []).entries()) {
    const record = asRecord(message);
    if (!record) throw new ValidationError(`messages[${index}] must be an object`);
    input.push(...messageToItems(record, `messages[${index}]`, options));
  }
  if (input.length === 0) throw new ValidationError('Claude request produced no Responses input items');

  const instructions = systemToInstructions(request.system, options);
  if (instructions !== undefined && options?.systemMessagesAsDeveloper) {
    input.unshift({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: instructions }] });
  }
  const body: Record<string, unknown> = {
    model,
    input,
    ...(instructions !== undefined && !options?.systemMessagesAsDeveloper ? { instructions } : {}),
    ...(request.stream === true ? { stream: true } : {}),
  };

  if (typeof request.max_tokens === 'number') body.max_output_tokens = request.max_tokens;
  if (typeof request.temperature === 'number') body.temperature = request.temperature;
  if (typeof request.top_p === 'number') body.top_p = request.top_p;

  const tools = responseTools(request.tools, request.mcp_servers, options);
  if (tools.length > 0) body.tools = tools;
  const toolChoice = responseToolChoice(request.tool_choice, tools.length > 0);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  // Claude states this on `tool_choice`; Responses states it one level up.
  if (asRecord(request.tool_choice)?.disable_parallel_tool_use === true) {
    body.parallel_tool_calls = false;
  }

  // Thinking → `reasoning`. The effort comes from the same threshold mapping every
  // other egress uses, so a budget that means "high" on the Completions route means
  // "high" here. `summary: 'auto'` is what makes the answer's reasoning visible to a
  // Claude client, which reads thinking blocks rather than a reasoning item; without
  // it the upstream returns no summary text and the client sees no thinking at all.
  const thinking = asRecord(request.thinking);
  const thinkingEnabled = thinking !== undefined && thinking.type !== 'disabled' && thinking.type !== false;
  if (thinkingEnabled) {
    const explicit = options?.conversion?.explicit_reasoning_effort ?? request.reasoning_effort ?? asRecord(request.output_config)?.effort;
    const budget = typeof thinking?.budget_tokens === 'number' ? thinking.budget_tokens : undefined;
    const effort = explicit ?? (budget !== undefined ? budgetToReasoningEffort(budget, options?.conversion) : undefined);
    body.reasoning = { summary: 'auto', ...(effort !== undefined ? { effort } : {}) };
  }

  // Structured outputs: Claude keeps the schema one level down in `output_config`;
  // Responses additionally requires a format name.
  const format = asRecord(asRecord(request.output_config)?.format);
  if (format !== undefined) {
    body.text = {
      format: format.type === 'json_schema'
        ? { ...format, name: typeof format.name === 'string' && format.name !== '' ? format.name : 'response' }
        : format,
    };
  }

  // `metadata` here accepts only `user_id`, which Responses carries as a free-form
  // map — so the one field Claude declares survives instead of being dropped.
  const userId = asRecord(request.metadata)?.user_id;
  if (typeof userId === 'string' && userId !== '') body.metadata = { user_id: userId };

  if (request.service_tier === 'auto') body.service_tier = 'auto';
  else if (request.service_tier !== undefined) {
    warn(options, `service_tier ${stringify(request.service_tier)} has no faithful Responses equivalent; dropped`);
  }

  const unsupported = [
    ['stop_sequences', request.stop_sequences],
    ['top_k', request.top_k],
    ['cached_content', request.cached_content],
    ['cache_control', request.cache_control],
    ['output_config.task_budget', asRecord(request.output_config)?.task_budget],
  ] as const;
  for (const [field, value] of unsupported) {
    if (value !== undefined) warn(options, `${field} has no faithful Responses equivalent; dropped`);
  }

  return body;
}
