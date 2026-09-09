/**
 * Request/response transform engine.
 *
 * Implements the two-tier transform system from design_request_transform_hooks.md:
 *   Tier 1 — generic ops (rename / set / default / remove / map_value) over shallow paths
 *   Tier 2 — named built-in ops for cases requiring deep recursion or cross-message lookup
 *
 * Entry point: runHook(hook, payload, ctx)
 */

import type { TransformSet, TransformOp, BuiltinName } from './config-loader.js';
import type { ModelRouteConfig } from './config-loader.js';
import type { Logger } from './logger.js';
import { sanitizeUpstreamResponseHeaders } from './routing.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HookPoint =
  | 'request_ingress'
  | 'before_conversion'
  | 'before_upstream'
  | 'after_upstream'
  | 'response_egress';

export interface HookContext {
  hook: HookPoint;
  route: ModelRouteConfig;
  upstreamMode: string;
  clientModel: string;
  requestId: string;
  streaming: boolean;
  logger: Logger;
  /** Upstream HTTP status — set on after_upstream / response_egress only. */
  status?: number;
}

export interface HookBodyPayload {
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** Transform a single SSE event object; return null to drop the event. */
export type EventTransformer = (
  event: Record<string, unknown>,
  ctx: HookContext,
) => Record<string, unknown> | null;

// ---------------------------------------------------------------------------
// Tier-2 built-in implementations
// ---------------------------------------------------------------------------

/**
 * Recursively lowercases every `type` field within a JSON-Schema object.
 * Ports the inline logic from chat-completions.ts:20-36 and openai.ts:88.
 */
function lowercaseSchemaTypes(schema: Record<string, unknown>): void {
  if (typeof schema.type === 'string') {
    schema.type = schema.type.toLowerCase();
  }
  if (schema.properties && typeof schema.properties === 'object') {
    for (const v of Object.values(schema.properties as Record<string, unknown>)) {
      if (v && typeof v === 'object') lowercaseSchemaTypes(v as Record<string, unknown>);
    }
  }
  if (Array.isArray(schema.items)) {
    for (const item of schema.items) {
      if (item && typeof item === 'object') lowercaseSchemaTypes(item as Record<string, unknown>);
    }
  } else if (schema.items && typeof schema.items === 'object') {
    lowercaseSchemaTypes(schema.items as Record<string, unknown>);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        if (branch && typeof branch === 'object') lowercaseSchemaTypes(branch as Record<string, unknown>);
      }
    }
  }
}

function applyBuiltin(
  name: BuiltinName,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  set: TransformSet,
  trace?: { logger: Logger; requestId: string; clientModel?: string },
): void {
  if (name === 'lowercase_tool_schema_types') {
    if (!Array.isArray(body.tools)) return;
    for (const tool of body.tools as Record<string, unknown>[]) {
      // OpenAI-completions shape: tool.function.parameters
      const fn = tool.function as Record<string, unknown> | undefined;
      if (fn?.parameters && typeof fn.parameters === 'object') {
        lowercaseSchemaTypes(fn.parameters as Record<string, unknown>);
      }
      // Anthropic-messages shape: tool.input_schema
      if (tool.input_schema && typeof tool.input_schema === 'object') {
        lowercaseSchemaTypes(tool.input_schema as Record<string, unknown>);
      }
    }
    return;
  }

  if (name === 'recover_tool_message_name') {
    // Ports chat-completions.ts:94-110.
    // Build an index of tool_call_id → function.name from assistant turns.
    if (!Array.isArray(body.messages)) return;
    const msgs = body.messages as Record<string, unknown>[];
    const toolCallIndex = new Map<string, string>();
    for (const msg of msgs) {
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls as Record<string, unknown>[]) {
          const id = tc.id as string | undefined;
          const fnName = (tc.function as Record<string, unknown> | undefined)?.name as string | undefined;
          if (id && fnName) toolCallIndex.set(id, fnName);
        }
      }
      if (msg.role === 'tool' && !msg.name) {
        const name = toolCallIndex.get(msg.tool_call_id as string);
        if (name) msg.name = name;
      }
    }
    return;
  }

  if (name === 'project_program_to_node_tool') {
    // EXPERIMENTAL / OPT-IN. Projects Responses `program` / `program_output`
    // items (programmatic tool calling) onto an ordinary `node` function call,
    // so an `openai-completions` upstream can carry them instead of the request
    // being rejected. Runs at `before_conversion`, rewriting items into types
    // convertResponsesToChatCompletions already handles; without this builtin
    // those items are refused with a 400 (see responses-to-completions.ts).
    //
    // This is a LOSSY projection, enabled only for testing against upstreams
    // whose behaviour you have verified. Two known hazards:
    //
    //  1. `fingerprint` is documented as an opaque replay token that "must be
    //     round-tripped". Here it becomes a `node` argument, which means the
    //     UPSTREAM model authors its value on the next turn — it will copy a
    //     stale one, invent one, or omit it. Whether the Responses platform
    //     tolerates that is not documented; assume replay is unreliable.
    //  2. It declares a `node` tool the client never asked for. Strict
    //     upstreams may reject an assistant turn calling an undeclared tool,
    //     and lenient ones may start calling `node` on their own — with no
    //     executor behind it. We therefore only project when the request
    //     already declares a `node` tool, and leave items untouched otherwise
    //     (the converter then rejects them, which is the safe default).
    if (!Array.isArray(body.input)) return;
    const items = body.input as Record<string, unknown>[];
    if (!items.some(it => it?.type === 'program' || it?.type === 'program_output')) return;

    const hasNodeTool = Array.isArray(body.tools) && (body.tools as Record<string, unknown>[]).some(t => {
      if (t?.name === 'node') return true;                       // responses-style tool
      const fn = t?.function as Record<string, unknown> | undefined;
      return fn?.name === 'node';                                 // completions-style tool
    });
    if (!hasNodeTool) {
      trace?.logger.warn(
        trace.requestId,
        '[project_program_to_node_tool] request contains program items but declares no `node` tool — leaving them unprojected (the converter will reject them). Declare a `node` tool to enable the projection.',
      );
      return;
    }

    body.input = items.map(item => {
      if (item?.type === 'program') {
        return {
          type: 'function_call',
          call_id: item.call_id,
          name: 'node',
          arguments: JSON.stringify({
            code: item.code ?? '',
            fingerprint: item.fingerprint ?? '',
            type: 'program',
          }),
          ...(item.id !== undefined ? { id: item.id } : {}),
        };
      }
      if (item?.type === 'program_output') {
        return {
          type: 'function_call_output',
          call_id: item.call_id,
          output: JSON.stringify({
            result: item.result ?? '',
            status: item.status ?? 'completed',
            type: 'program_output',
          }),
          ...(item.id !== undefined ? { id: item.id } : {}),
        };
      }
      return item;
    });
    return;
  }

  if (name === 'inject_missing_tool_results') {
    // Anthropic-format invariant: every tool_use.id in an assistant message
    // must be matched by a tool_result.tool_use_id in the immediately
    // following user message (all results in ONE pure-tool_result user message).
    //
    // DeepSeek's Anthropic-compatible endpoint enforces three constraints stricter
    // than the base Anthropic spec:
    //
    // A. No mixed assistant content: an assistant message must contain EITHER
    //    tool_use blocks OR text — not both. When completionsBodyToClaudeBody
    //    converts Completions-format messages, the Codex SDK often emits the
    //    assistant turn as two separate Completions messages:
    //      [i]   assistant {tool_calls}     → assistant [tu:A, tu:B]
    //      [i+1] assistant "text…"          → assistant [text]
    //    These become two consecutive assistant messages in the Anthropic body,
    //    and the tool_results land at [i+2] and [i+3] (one per call).
    //    We must reorder: move the tool_result user message to IMMEDIATELY after
    //    the tool_use assistant, before the text-only assistant.
    //
    // B. All tool_results for one assistant turn in ONE user message: when
    //    multiple role:"tool" messages follow one assistant, each becomes its own
    //    user message. We merge consecutive pure-tool user messages into the first.
    //
    // C. No missing tool_result: if after the above steps a tool_use id still
    //    lacks a matching tool_result, synthesize a placeholder block.
    //
    // The algorithm runs a single forward pass. After each handled pair we advance
    // i past the tool_result user message to avoid re-processing it.
    if (!Array.isArray(body.messages)) return;
    const msgs = body.messages as Record<string, unknown>[];

    const isPureToolMessage = (msg: Record<string, unknown>): boolean => {
      if (msg.role !== 'user') return false;
      const c = msg.content;
      return Array.isArray(c) && (c as Array<Record<string, unknown>>).length > 0 &&
        (c as Array<Record<string, unknown>>).every(b => b.type === 'tool_result');
    };

    const hasToolUseBlocks = (msg: Record<string, unknown>): boolean => {
      if (msg.role !== 'assistant') return false;
      const c = msg.content;
      return Array.isArray(c) &&
        (c as Array<Record<string, unknown>>).some(b => b.type === 'tool_use');
    };

    for (let i = 0; i < msgs.length; i++) {
      if (!hasToolUseBlocks(msgs[i])) continue;

      // Collect tool_use ids from this assistant message.
      const assistant = msgs[i];
      const toolUseIds = new Set<string>();
      for (const block of assistant.content as Array<Record<string, unknown>>) {
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          toolUseIds.add(block.id);
        }
      }
      // toolUseIds is guaranteed non-empty by hasToolUseBlocks.

      // CONSTRAINT A: skip any consecutive text-only assistant messages between
      // this assistant and the tool_result user messages. Collect them into a
      // "tail" list so we can put them back after the tool_result message.
      const tailAssistants: Array<Record<string, unknown>> = [];
      let j = i + 1;
      while (j < msgs.length && msgs[j].role === 'assistant' && !hasToolUseBlocks(msgs[j])) {
        tailAssistants.push(msgs[j]);
        j++;
      }

      // j now points to the first non-assistant message after the tail.
      // This should be the user message with tool_results (or end of array).
      const noFollowingUser = j >= msgs.length || msgs[j].role !== 'user';

      // CONSTRAINT B: collect all consecutive pure-tool user messages starting at j,
      // merging their blocks into a single list. When no following user message
      // exists (trailing tool_use), the block list starts empty and constraint C
      // below synthesizes a placeholder for every tool_use id.
      const toolResultBlocks: Array<Record<string, unknown>> = [];
      const presentIds = new Set<string>();
      let k = j;
      if (!noFollowingUser) {
        while (k < msgs.length && isPureToolMessage(msgs[k])) {
          for (const block of msgs[k].content as Array<Record<string, unknown>>) {
            toolResultBlocks.push(block);
            if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
              presentIds.add(block.tool_use_id);
            }
          }
          k++;
        }
      }
      // k is now the index just past the last pure-tool message (== j when
      // noFollowingUser, since the inner loop is skipped).

      // CONSTRAINT C: synthesize any missing tool_result blocks.
      for (const toolUseId of toolUseIds) {
        if (!presentIds.has(toolUseId)) {
          toolResultBlocks.push({ type: 'tool_result', tool_use_id: toolUseId, content: '' });
        }
      }

      // If nothing is missing and structure is already correct, skip the rewrite.
      // noFollowingUser always needs a rewrite when toolResultBlocks is non-empty
      // (we must append a new user message), so exclude it from the happy path.
      if (!noFollowingUser && tailAssistants.length === 0 && k - j === 1 && toolResultBlocks.length === (msgs[j].content as Array<unknown>).length) {
        // Happy path: already [tool_use_assistant, single_pure_tool_user, ...].
        // No structural changes needed — all tool_results are present and already
        // in a single user message immediately after the assistant.
        i++; // skip the tool_result user message
        continue;
      }

      // Restructure: remove the tail assistants and all the pure-tool user messages
      // from their current positions, then re-insert in the correct order:
      //   [i]   tool_use_assistant  (unchanged)
      //   [i+1] user (single consolidated pure-tool_result message)
      //   [i+2…] tailAssistants (text-only assistants come AFTER the tool_results)
      //   [k…]  whatever came after k
      //
      // We do this by splicing out indices [i+1 .. k-1] and replacing them with
      // [consolidated_user_msg, ...tailAssistants].
      const toolResultMsg: Record<string, unknown> = {
        role: 'user',
        content: toolResultBlocks,
      };
      msgs.splice(i + 1, k - (i + 1), toolResultMsg, ...tailAssistants);

      // Advance i past the consolidated user message so we don't re-examine it.
      i++;
    }
    return;
  }

  if (name === 'strip_fresh_thinking') {
    // DeepSeek's Anthropic-compatible endpoint rejects an explicit
    // thinking-enabled request whose conversation has no prior assistant
    // thinking blocks (e.g. the first request of a conversation) with
    // 400 "The content[].thinking in the thinking mode must be passed back
    // to the API". Deleting the flag lets the upstream fall back to its
    // internal default, which tolerates a thinking-less history.
    const thinking = body.thinking;
    if (typeof thinking !== 'object' || thinking === null) return;
    const type = (thinking as Record<string, unknown>).type;
    const isEnabled = type === 'enabled' || type === true || type === 'adaptive';
    if (!isEnabled) return;
    const messages = body.messages;
    if (!Array.isArray(messages)) return;
    const hasPriorThinking = (messages as Array<Record<string, unknown>>).some(msg =>
      msg.role === 'assistant' && Array.isArray(msg.content) &&
      (msg.content as Array<Record<string, unknown>>).some(b => b.type === 'thinking'),
    );
    if (!hasPriorThinking) delete body.thinking;
    return;
  }

  if (name === 'ensure_tool_config_cache_ttl') {
    // Translate the Anthropic-native system-block cache_control into the
    // litellm/Bedrock-bridge convention cache_control_injection_points.
    //
    // Direction: READ cache_control from body.system content blocks (the
    // array-of-blocks shape; a plain-string system carries no block-level
    // cache_control and is ignored), then WRITE a {location:"tool_config"}
    // entry into body.cache_control_injection_points — appending only when
    // no tool_config entry already exists (caller-provided entries win).
    //
    // The serialized body must place cache_control_injection_points AFTER
    // tools (some downstreams are sensitive to field order), so when tools
    // is present we rebuild the body key order to enforce it.
    //
    // Canonical system block shape (per platform.claude.com prompt-caching):
    //   system: [{type:"text", text:"...", cache_control:{type:"ephemeral", ttl?:"1h"}}]
    if (!Array.isArray(body.system)) return;

    // Find the first system block carrying a usable cache_control.
    let derived: Record<string, unknown> | undefined;
    for (const block of body.system as Record<string, unknown>[]) {
      const cc = block.cache_control;
      if (!cc || typeof cc !== 'object') continue;
      const ccObj = cc as Record<string, unknown>;
      if (typeof ccObj.type !== 'string') continue;
      derived = { ...ccObj };
      break;
    }
    if (!derived) return;

    const injections = body.cache_control_injection_points;
    if (Array.isArray(injections)) {
      // Caller-wins: if a tool_config entry already exists, leave it untouched.
      const hasToolConfig = (injections as Record<string, unknown>[]).some(
        inj => inj.location === 'tool_config',
      );
      if (hasToolConfig) return;
    }

    // Append the derived entry.
    const entry: Record<string, unknown> = {
      location: 'tool_config',
      control: derived,
    };
    if (Array.isArray(injections)) {
      (injections as Record<string, unknown>[]).push(entry);
    } else {
      body.cache_control_injection_points = [entry];
    }

    // Enforce field order: cache_control_injection_points must land AFTER tools.
    if ('tools' in body) {
      const ccip = body.cache_control_injection_points;
      delete body.cache_control_injection_points;
      body.cache_control_injection_points = ccip;
    }
    return;
  }

  if (name === 'ensure_trailing_user_message') {
    // Some Anthropic-compatible upstreams reject a `messages` array that
    // doesn't end on role:"user" — including both real "assistant message
    // prefill" (ending on role:"assistant" to force a specific continuation,
    // which Anthropic's own API allows) and a trailing role:"system" message
    // (Claude Code sometimes emits an inline agent-definitions block as
    // role:"system" in `messages`, alongside the normal top-level `system`
    // field; real Anthropic tolerates this, some upstreams don't). Either
    // case gets reported by these upstreams as the same generic 400
    // "This model does not support assistant message prefill. The
    // conversation must end with a user message." error.
    //
    // Strip trailing non-user messages outright (repeatedly, in case more
    // than one is stacked at the tail) so the conversation ends on a user
    // turn. No-op if messages is empty/absent or already ends with a user
    // message.
    if (!Array.isArray(body.messages)) return;
    const msgs = body.messages as Record<string, unknown>[];
    while (msgs.length > 0 && msgs[msgs.length - 1].role !== 'user') {
      const last = msgs.pop()!;
      if (trace) {
        trace.logger.trace(trace.requestId, `[ensure_trailing_user_message] stripped trailing ${String(last.role)} message: ${JSON.stringify(last)}`);
      }
    }
    return;
  }

  // assemble_sse_chunks is handled at the Response level in applyAfterUpstream,
  // not here (it operates on a stream, not a buffered JSON body).
  if (name === 'assemble_sse_chunks') return;

  if (name === 'filter_anthropic_beta') {
    // Filter and optionally rename entries in the anthropic-beta header using
    // the owning set's `anthropic_beta_map`. Mirrors LiteLLM's
    // anthropic_beta_headers_config.json semantics (docs/claude-beta-headers.md):
    //   - entry not in map           → drop
    //   - map value is null / ""     → drop
    //   - map value is a non-empty   → emit the mapped name
    // Input format is the real Claude Code comma-separated form
    // (e.g. "a,b,c") — NOT the JSON array form beta-features.ts handles.
    const raw = headers['anthropic-beta'];
    if (!raw) return;
    const map = set.anthropic_beta_map;
    if (!map) return; // defensive: no map → pass through unchanged
    const entries = raw.split(',').map(e => e.trim()).filter(Boolean);
    const out: string[] = [];
    for (const entry of entries) {
      const mapped = map[entry];
      if (mapped === undefined) continue;          // not in map → drop
      if (mapped === null || mapped === '') continue; // explicit drop
      out.push(mapped);
    }
    if (out.length === 0) {
      delete headers['anthropic-beta'];
    } else {
      headers['anthropic-beta'] = out.join(',');
    }
    return;
  }

  if (name === 'restore_client_model_alias') {
    // Rewrite the response body's model field back to the alias the client
    // requested, undoing the alias->target rewrite applied to the request
    // (index.ts:1300-1304). Runs on response_egress only (buffered JSON body
    // via applyWriteoutBody, and per-event via buildEventTransformer for SSE).
    if (trace?.clientModel && typeof body.model === 'string') {
      body.model = trace.clientModel;
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// Tier-1 path resolution helpers
// ---------------------------------------------------------------------------

/** Splits a path into (kind, field, roleFilter | null). */
function parsePath(path: string): {
  kind: 'top' | 'messages' | 'response';
  field: string;
  roleFilter: string | null;
} {
  // messages[].field  or  messages[role=X].field
  const msgMatch = path.match(/^messages\[(?:role=(\w+))?\]\.(.+)$/);
  if (msgMatch) {
    return { kind: 'messages', field: msgMatch[2], roleFilter: msgMatch[1] ?? null };
  }
  // $response.<field> — response-side path, applied to the body root (the
  // response schema mirrors the request schema, so we just rewrite a top-level
  // field of the same shape). Bracket suffixes like `choices[].message.role`
  // are not yet supported; the validator accepts them but they will fall back
  // to literal-key assignment until path-walk is added.
  if (path.startsWith('$response.')) {
    return { kind: 'response', field: path.slice('$response.'.length), roleFilter: null };
  }
  // top-level single segment (no dots, no brackets)
  return { kind: 'top', field: path, roleFilter: null };
}

function applyOpToBody(op: TransformOp, body: Record<string, unknown>): void {
  const parsed = parsePath(op.path);

  if (parsed.kind === 'top' || parsed.kind === 'response') {
    // Both 'top' and 'response' rewrite a top-level field of the body. The
    // distinction exists only for the parsePath API so callers can tell what
    // side they're touching; the body shape is the same.
    applyOpToObject(op, body, parsed.field);
    return;
  }

  if (parsed.kind === 'messages' && Array.isArray(body.messages)) {
    const msgs = body.messages as Record<string, unknown>[];
    for (const msg of msgs) {
      if (parsed.roleFilter && msg.role !== parsed.roleFilter) continue;
      applyOpToObject(op, msg, parsed.field);
    }
  }
}

function applyOpToObject(op: TransformOp, obj: Record<string, unknown>, field: string): void {
  switch (op.op) {
    case 'rename': {
      if (field in obj) {
        obj[op.to] = obj[field];
        delete obj[field];
      }
      break;
    }
    case 'set': {
      obj[field] = op.value;
      break;
    }
    case 'default': {
      if (!(field in obj) || obj[field] === undefined) {
        obj[field] = op.value;
      }
      break;
    }
    case 'remove': {
      delete obj[field];
      break;
    }
    case 'map_value': {
      // If when_sibling guard is set, only apply when that sibling key exists
      if (op.when_sibling && !(op.when_sibling in obj)) break;
      if (obj[field] === op.from) {
        obj[field] = op.to;
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Header transforms
// ---------------------------------------------------------------------------

function applyHeaderTransforms(
  headers: Record<string, string>,
  headerSpec: { set?: Record<string, string>; remove?: string[] } | undefined,
): Record<string, string> {
  if (!headerSpec) return headers;
  const result = { ...headers };
  for (const [k, v] of Object.entries(headerSpec.set ?? {})) {
    result[k] = v;
  }
  for (const k of headerSpec.remove ?? []) {
    delete result[k];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Core: apply one transform set at one hook
// ---------------------------------------------------------------------------

function applyTransformSet(
  set: TransformSet,
  hook: HookPoint,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  trace?: { logger: Logger; requestId: string; clientModel?: string },
): { body: Record<string, unknown>; headers: Record<string, string> } {
  const slot = set[hook];
  if (!slot) return { body, headers };

  // Tier-2 built-ins first
  for (const b of slot.builtins ?? []) {
    applyBuiltin(b, body, headers, set, trace);
  }

  // Tier-1 ops in declared order
  for (const op of slot.ops ?? []) {
    applyOpToBody(op, body);
  }

  // Header transforms (before_upstream / response_egress only)
  const headerSpec = (slot as { headers?: { set?: Record<string, string>; remove?: string[] } }).headers;
  headers = applyHeaderTransforms(headers, headerSpec);

  return { body, headers };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a single DEBUG line summarising the resolved transforms for a route.
 * Format: `transforms: <hook>=[<set>:b=N,ops=N] …`
 * Only hooks that have at least one builtin or op in at least one set are listed.
 * Returns an empty string when there are no transforms (caller should skip logging).
 */
export function formatTransformsDebug(transforms: TransformSet[]): string {
  if (!transforms || transforms.length === 0) return '';
  const HOOKS: HookPoint[] = ['request_ingress', 'before_conversion', 'before_upstream', 'after_upstream', 'response_egress'];
  const parts: string[] = [];
  for (const hook of HOOKS) {
    const activeSets = transforms.filter(s => s[hook] !== undefined);
    if (activeSets.length === 0) continue;
    const setDescs = activeSets.map(s => {
      const slot = s[hook]!;
      const tokens: string[] = [];
      const b = slot.builtins?.length ?? 0;
      const ops = slot.ops?.length ?? 0;
      if (b > 0) tokens.push(`b=${b}`);
      if (ops > 0) tokens.push(`ops=${ops}`);
      return `${s.name}:${tokens.join(',')}`;
    });
    parts.push(`${hook}=[${setDescs.join(' ')}]`);
  }
  if (parts.length === 0) return '';
  return `transforms: ${parts.join(' ')}`;
}

/**
 * Per-entry `max_tokens` cap paths per upstream mode, checked in order.
 * openai-completions checks both names because the `max_tokens_rename`
 * transform may have renamed the field at this hook; gemini bodies may carry
 * the snake_case converted form or a camelCase native-client form.
 */
const MAX_OUTPUT_TOKENS_PATHS: Record<string, string[]> = {
  'anthropic-messages': ['max_tokens'],
  'openai-completions': ['max_completion_tokens', 'max_tokens'],
  'openai-responses': ['max_output_tokens'],
  'gemini': ['generation_config.max_output_tokens', 'generationConfig.maxOutputTokens'],
};

/**
 * Clamp the upstream body's max-output-tokens field down to the per-entry
 * `route.maxTokens` cap when the client (or a transform) requested a larger
 * value. Smaller client values pass through unchanged. No-op when the entry
 * sets no cap or the mode has no known field path.
 */
function applyMaxTokensCap(body: Record<string, unknown>, ctx: HookContext): void {
  const cap = ctx.route.maxTokens;
  if (cap === undefined) return;
  const paths = MAX_OUTPUT_TOKENS_PATHS[ctx.upstreamMode];
  if (!paths) return;
  for (const path of paths) {
    const parts = path.split('.');
    let node: Record<string, unknown> = body;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = node[parts[i]];
      if (typeof next !== 'object' || next === null) { node = {} as Record<string, unknown>; break; }
      node = next as Record<string, unknown>;
    }
    const leaf = parts[parts.length - 1];
    const current = node[leaf];
    if (typeof current === 'number' && current > cap) {
      ctx.logger.debug(ctx.requestId, `max output tokens ${current} exceeds per-entry cap ${cap} (${path}), clamping`);
      node[leaf] = cap;
    }
  }
}

/**
 * Run all transforms declared for `hook` across the resolved transform list.
 * Folds left-to-right: each set sees the output of the previous.
 */
export function runHook(
  hook: HookPoint,
  payload: HookBodyPayload,
  ctx: HookContext,
): HookBodyPayload {
  const transforms = ctx.route.transforms;
  const needsCap = hook === 'before_upstream' && ctx.route.maxTokens !== undefined;
  if (!transforms || transforms.length === 0) {
    if (!needsCap) return payload;
    applyMaxTokensCap(payload.body, ctx);
    return payload;
  }

  let { body, headers } = payload;
  for (const set of transforms) {
    ({ body, headers } = applyTransformSet(set, hook, body, headers, { logger: ctx.logger, requestId: ctx.requestId, clientModel: ctx.clientModel }));
  }
  if (needsCap) applyMaxTokensCap(body, ctx);
  return { body, headers };
}

/**
 * Apply `after_upstream` transforms to a raw upstream Response.
 *
 * Fast-path: if no transforms declare ops at `after_upstream`, returns the
 * original Response object unchanged (no buffering, no overhead).
 *
 * Active path: buffers the response body as JSON, applies all declared ops,
 * and returns a new Response with the modified JSON body (same status/headers).
 * If the body is not valid JSON, it is passed through unchanged.
 *
 * Call this immediately after `fetch()`, before any `if (!response.ok)` check:
 *   const response = await fetch(...);
 *   const transformed = await applyAfterUpstream(response, ctx);
 *   if (!transformed.ok) { ... }
 */
export async function applyAfterUpstream(
  response: Response,
  ctx: HookContext,
): Promise<Response> {
  const transforms = ctx.route.transforms;
  if (!transforms || transforms.length === 0) return response;

  const activeSets = transforms.filter(s => s['after_upstream'] !== undefined);
  if (activeSets.length === 0) return response;

  // If any active set declares assemble_sse_chunks and the upstream sent SSE,
  // buffer all chunks and assemble into a single chat.completion JSON.
  const needsAssembly = activeSets.some(s =>
    s['after_upstream']?.builtins?.includes('assemble_sse_chunks'),
  );
  const contentType = response.headers.get('content-type') ?? '';
  if (needsAssembly && !contentType.includes('text/event-stream')) {
    ctx.logger.warn(ctx.requestId, `assemble_sse_chunks: expected text/event-stream from upstream but got "${contentType || '(none)'}"; skipping assembly and passing response through unchanged`);
  }
  if (needsAssembly && contentType.includes('text/event-stream')) {
    const assembled = await assembleSseChunks(response);
    // Re-enter the normal JSON-ops path with the assembled body.
    const hookCtx: HookContext = { ...ctx, status: response.status };
    let body = assembled;
    let headers: Record<string, string> = {};
    for (const set of activeSets) {
      ({ body, headers } = applyTransformSet(set, 'after_upstream', body, headers, { logger: ctx.logger, requestId: ctx.requestId, clientModel: ctx.clientModel }));
      void headers;
    }
    const responseHeaders = sanitizeUpstreamResponseHeaders(response);
    responseHeaders.set('content-type', 'application/json');
    return new Response(JSON.stringify(body), {
      status: hookCtx.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  }

  // Buffer body and parse JSON.
  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON — reconstruct original response and return unchanged.
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: sanitizeUpstreamResponseHeaders(response),
    });
  }

  // Apply ops (status available in ctx).
  const hookCtx: HookContext = { ...ctx, status: response.status };
  let headers: Record<string, string> = {};
  for (const set of activeSets) {
    ({ body, headers } = applyTransformSet(set, 'after_upstream', body, headers));
    void headers; // header ops not supported on after_upstream (response headers come from fetch)
  }

  return new Response(JSON.stringify(body), {
    status: hookCtx.status,
    statusText: response.statusText,
    headers: sanitizeUpstreamResponseHeaders(response),
  });
}

/**
 * Read an OpenAI SSE stream to completion and assemble all chat.completion.chunk
 * events into a single chat.completion JSON object.
 *
 * Chunks may arrive with choices in any order and with any index values. The
 * assembled choices array is sorted by index. Content deltas are concatenated
 * in arrival order per index. Tool-call argument deltas are concatenated per
 * (choice index, tool-call index) pair. The finish_reason and tool_calls id/name
 * from the last chunk that carries them per choice are used. Usage is taken from
 * the final chunk that includes a non-null usage object (stream_options.include_usage).
 */
async function assembleSseChunks(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();

  // Per-choice accumulation state.
  interface ChoiceState {
    index: number;
    role: string;
    content: string;
    finish_reason: string | null;
    // tool_calls keyed by tool-call index
    toolCalls: Map<number, { id: string; type: string; name: string; arguments: string }>;
  }
  const choices = new Map<number, ChoiceState>();
  let id = '';
  let model = '';
  let created = 0;
  let usage: Record<string, unknown> | null = null;

  const getChoice = (idx: number): ChoiceState => {
    if (!choices.has(idx)) {
      choices.set(idx, { index: idx, role: 'assistant', content: '', finish_reason: null, toolCalls: new Map() });
    }
    return choices.get(idx)!;
  };

  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') continue;
    let chunk: Record<string, unknown>;
    try { chunk = JSON.parse(payload); } catch { continue; }

    if (typeof chunk.id === 'string' && chunk.id) id = chunk.id;
    if (typeof chunk.model === 'string' && chunk.model) model = chunk.model;
    if (typeof chunk.created === 'number' && chunk.created) created = chunk.created;
    if (chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage as Record<string, unknown>;

    const chunkChoices = chunk.choices as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(chunkChoices)) continue;

    for (const c of chunkChoices) {
      const idx = typeof c.index === 'number' ? c.index : 0;
      const state = getChoice(idx);
      const delta = c.delta as Record<string, unknown> | undefined;
      if (!delta) continue;

      if (typeof delta.role === 'string') state.role = delta.role;
      if (typeof delta.content === 'string') state.content += delta.content;
      if (typeof c.finish_reason === 'string') state.finish_reason = c.finish_reason;

      const tcDeltas = delta.tool_calls as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(tcDeltas)) {
        for (const tc of tcDeltas) {
          const tcIdx = typeof tc.index === 'number' ? tc.index : 0;
          if (!state.toolCalls.has(tcIdx)) {
            state.toolCalls.set(tcIdx, { id: '', type: 'function', name: '', arguments: '' });
          }
          const entry = state.toolCalls.get(tcIdx)!;
          if (typeof tc.id === 'string') entry.id = tc.id;
          if (typeof tc.type === 'string') entry.type = tc.type;
          const fn = tc.function as Record<string, unknown> | undefined;
          if (fn) {
            if (typeof fn.name === 'string') entry.name += fn.name;
            if (typeof fn.arguments === 'string') entry.arguments += fn.arguments;
          }
        }
      }
    }
  }

  // Build sorted choices array.
  const sortedChoices = Array.from(choices.values())
    .sort((a, b) => a.index - b.index)
    .map(state => {
      const message: Record<string, unknown> = { role: state.role, content: state.content || null };
      if (state.toolCalls.size > 0) {
        message.content = state.content || null;
        message.tool_calls = Array.from(state.toolCalls.entries())
          .sort(([a], [b]) => a - b)
          .map(([, tc]) => ({
            id: tc.id,
            type: tc.type,
            function: { name: tc.name, arguments: tc.arguments },
          }));
      }
      return { index: state.index, message, finish_reason: state.finish_reason };
    });

  const result: Record<string, unknown> = {
    id: id || `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created: created || Math.floor(Date.now() / 1000),
    model,
    choices: sortedChoices,
  };
  if (usage) result.usage = usage;
  return result;
}

/**
 * Build an EventTransformer for streaming responses at `hook`.
 * Returns null if no transforms declare ops at this hook (fast path).
 */
export function buildEventTransformer(
  hook: HookPoint,
  ctx: HookContext,
): EventTransformer | null {
  const transforms = ctx.route.transforms;
  if (!transforms || transforms.length === 0) return null;

  const activeSets = transforms.filter(s => s[hook] !== undefined);
  if (activeSets.length === 0) return null;

  return (event, _ctx) => {
    let body = event;
    let headers: Record<string, string> = {};
    for (const set of activeSets) {
      ({ body, headers } = applyTransformSet(set, hook, body, headers, { logger: ctx.logger, requestId: ctx.requestId, clientModel: ctx.clientModel }));
      void headers; // headers not used on stream events
    }
    return body;
  };
}

/**
 * Check whether any declared transform set has ops at `hook` — used as a fast-path
 * gate by `applyWriteoutBody` and `pipeEventTransformer` to avoid cloning/buffering
 * when no rules fire.
 */
export function hasHookOps(hook: HookPoint, transforms: TransformSet[] | undefined): boolean {
  if (!transforms || transforms.length === 0) return false;
  return transforms.some(s => s[hook] !== undefined);
}

/**
 * Apply `response_egress` body transforms to a final client Response.
 *
 * - Fast-path: when no transforms declare `response_egress` ops, returns the
 *   original Response unchanged (no buffering).
 * - Buffered JSON: buffers the body, applies ops, returns a new Response with
 *   the rewritten JSON body (status/headers preserved).
 * - Non-JSON bodies (including SSE streams): passed through unchanged.
 *
 * Streaming transform support lives in `pipeEventTransformer` — call sites that
 * want per-event SSE rewriting for the writeout hook wrap their stream with it.
 *
 * Mirror of `applyAfterUpstream` but on the client-schema response.
 */
export async function applyWriteoutBody(
  response: Response,
  ctx: HookContext,
): Promise<Response> {
  if (!hasHookOps('response_egress', ctx.route.transforms)) return response;

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return response;

  // Buffer body and parse JSON.
  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: sanitizeUpstreamResponseHeaders(response),
    });
  }

  // Apply ops.
  const hookCtx: HookContext = { ...ctx, status: response.status };
  let headers: Record<string, string> = {};
  for (const set of ctx.route.transforms!) {
    const slot = set['response_egress'];
    if (!slot) continue;
    ({ body, headers } = applyTransformSet(set, 'response_egress', body, headers, { logger: ctx.logger, requestId: ctx.requestId, clientModel: ctx.clientModel }));
    void headers; // header ops on response_egress run in index.ts central wrap
  }
  void hookCtx;

  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers: sanitizeUpstreamResponseHeaders(response),
  });
}

/**
 * Wrap an SSE byte stream so each `data: {...}\n\n` event passes through the
 * writeout hook's per-event transformer before being written to the new stream.
 *
 * Returns the original stream body unchanged when no transforms declare
 * `response_egress` ops (fast path). Events whose transformer returns null are
 * dropped. Other events are re-emitted as `data: <json>\n\n`. Non-data lines and
 * blank-line-terminated comments are passed through verbatim.
 */
export function pipeEventTransformer(
  responseBody: ReadableStream<Uint8Array>,
  ctx: HookContext,
): ReadableStream<Uint8Array> | null {
  const transformer = buildEventTransformer('response_egress', ctx);
  if (!transformer) return null;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  return new ReadableStream({
    async start(controller) {
      const reader = responseBody.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE events are delimited by blank line.
          const events = buffer.split('\n\n');
          buffer = events.pop() ?? '';
          for (const ev of events) {
            if (!ev.trim()) continue;
            const transformed = transformSseEvent(ev, transformer, ctx, controller, encoder);
            if (transformed === null) continue; // dropped
            // `transformSseEvent` already pushed bytes when applicable
          }
        }
        // flush trailing buffer
        if (buffer.trim()) {
          transformSseEvent(buffer, transformer, ctx, controller, encoder);
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
}

function transformSseEvent(
  eventText: string,
  transformer: EventTransformer,
  ctx: HookContext,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
): null | undefined {
  // Find the data: line(s); multi-data events are concatenated as a JSON array by spec
  // but most providers use one data: line per event. We treat single-line events.
  const lines = eventText.split('\n');
  const dataParts: string[] = [];
  const otherLines: string[] = [];
  let terminated = false;
  for (const line of lines) {
    if (line.startsWith('data:')) {
      // data: payload (no space) or "data: payload" (single space).
      const payload = line.startsWith('data: ') ? line.slice(6) : line.slice(5);
      if (payload === '[DONE]') {
        // Sentinel — always pass through unchanged so clients terminate cleanly.
        controller.enqueue(encoder.encode(`${line}\n\n`));
        continue;
      }
      dataParts.push(payload);
    } else if (line === '') {
      terminated = true;
    } else {
      otherLines.push(line);
    }
  }
  if (dataParts.length === 0) {
    // Comments / event: / id: lines — pass through verbatim
    controller.enqueue(encoder.encode(`${eventText}\n\n`));
    return undefined;
  }
  // Parse the data payload (assume JSON; non-JSON falls through unchanged).
  const json = dataParts.join('\n');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json);
  } catch {
    controller.enqueue(encoder.encode(`${eventText}\n\n`));
    return undefined;
  }
  const next = transformer(parsed, ctx);
  if (next === null) return null; // dropped
  const reSerialized = `data: ${JSON.stringify(next)}`;
  controller.enqueue(encoder.encode(`${reSerialized}\n\n`));
  void terminated;
  void otherLines;
  return undefined;
}
