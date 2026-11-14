/**
 * Gemini request → OpenAI Chat Completions conversion.
 *
 * The ingress half of the cross-mode bridge: a client speaking the generateContent
 * or Interactions protocol is converted to a Completions body here, so that a
 * non-Gemini upstream — openai-completions natively, anthropic-messages and
 * openai-responses through a second hop — receives one intermediate shape. The
 * egress halves live in `openai-to-gemini.ts` (Completions → Gemini) and
 * `handlers/cross-mode-stream.ts` (upstream SSE → Completions chunks).
 *
 * Moved out of `src/handlers/openai.ts` to follow the convention the other
 * converters already use: one file per `from`-`to` pair.
 */

import type { Logger } from '../types/shared.js';
import { isBlobRef, rebindBlobRef, type BlobRef } from '../utils/blob-refs.js';
import { ValidationError } from '../utils/errors.js';
import { functionArgs } from './interactions-to-gemini.js';

/**
 * Check if request is in Gemini Interactions format
 */
export function isGeminiInteractionsRequest(body: Record<string, unknown>): boolean {
  return 'input' in body || 'contents' in body;
}

/**
 * The Interactions `type` discriminators whose part carries its bytes at its own
 * `data`/`mime_type` (`{type:'image', data, mime_type}`) rather than under
 * generateContent's `inline_data`. The media kinds `interactions.md` declares.
 */
const INTERACTIONS_MEDIA_PART_TYPES = new Set(['image', 'audio', 'video', 'document']);

/**
 * The `input` *step* vocabulary: the `type` discriminator of every member of the
 * SDK's `Step` union, which is the `Array<Step>` arm of `InteractionsInput`
 * (`@google/genai` `genai.d.ts`). `function_call`, `function_result` and
 * `thought` are also Content part types, so an array headed by one is ambiguous
 * between a step list and a part list — both readings mean the same thing, and
 * the step reading is the one that gives a tool call or a thought the message of
 * its own that Completions needs.
 *
 * The last fourteen are recognized so that an array headed by one is read as a
 * step list, where the step can be refused by name. None has a Completions
 * spelling; read as a part list instead they matched nothing and the whole array
 * became an empty `content`, with no warning (rule #8).
 */
const INTERACTIONS_STEP_TYPES = new Set([
  'user_input', 'model_output',
  'function_call', 'function_result', 'thought',
  'code_execution_call', 'code_execution_result',
  'file_search_call', 'file_search_result',
  'google_maps_call', 'google_maps_result',
  'google_search_call', 'google_search_result',
  'mcp_server_tool_call', 'mcp_server_tool_result',
  'processing_call', 'processing_result',
  'url_context_call', 'url_context_result',
]);

/**
 * Convert Gemini parts into an OpenAI Completions `content` value:
 *   - text-only parts collapse to a joined string (preserves wire shape).
 *   - any image part present → returns an array mixing `{type:'text'}` and
 *     `{type:'image_url'}` parts (data-URI form). Both the generateContent
 *     spellings (`inline_data.mime_type`, `inlineData.mimeType`) and the
 *     Interactions one (`{type:'image', data, mime_type}`) are accepted.
 *   - `thought:true` text parts are skipped (thinking markers; not part of
 *     content body in this direction).
 * Returns '' for an empty / unrecognized parts list.
 *
 * A part this hop cannot express is refused rather than skipped: skipping it is
 * what let a whole turn arrive at the upstream as an empty `content`, with the
 * part's payload gone and nothing said (rule #8). The three refused kinds are
 * the ones needing a *message*-level position on this wire — `thought`
 * (`reasoning_content`), `function_call` / `function_result` (`tool_calls` /
 * `role:'tool'`) — plus a media part carrying no inline bytes. They are read at
 * the top level of `input` as steps, which is where the SDK puts them.
 * `interactions-to-gemini.ts` translates the same three as *parts*, which fits
 * there because generateContent declares a part for each; Completions declares
 * none, so the two front doors diverge on where the value can sit, not on
 * whether it survives.
 *
 * Used by `convertGeminiInteractionsToOpenAI` (Interactions-API client →
 * openai-completions upstream). `convertGeminiGenerateContentToOpenAI` keeps
 * its own inline copy (see `convertGeminiGenerateContentToOpenAI` below) because the image extraction there
 * interleaves with the funcCallParts / funcRespParts / thinkingContent
 * branching.
 */
function geminiPartsToOpenAIContent(
  parts: any[] | undefined,
  where: string,
): string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string | BlobRef } }> {
  if (!Array.isArray(parts)) return '';
  const textParts: string[] = [];
  const imageParts: Array<{ type: 'image_url'; image_url: { url: string | BlobRef } }> = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] as any;
    const at = `${where}[${i}]`;
    let claimed = false;
    if (p && typeof p.text === 'string') {
      claimed = true;
      if (!p.thought) textParts.push(p.text);
    }
    // Whichever dialect spells the bytes: the generateContent part nests them
    // under `inline_data`, the Interactions part carries them on itself.
    const inline = p?.inline_data ?? p?.inlineData;
    const media = inline ?? (INTERACTIONS_MEDIA_PART_TYPES.has(p?.type) ? p : undefined);
    const mime = media?.mime_type ?? media?.mimeType;
    const data: unknown = media?.data;
    if ((typeof data === 'string' && data !== '') || isBlobRef(data)) {
      claimed = true;
      imageParts.push({
        type: 'image_url',
        image_url: {
          url: isBlobRef(data)
            ? rebindBlobRef(data, 'chat-image-url', `data:${mime || 'image/jpeg'};base64,`)
            : `data:${mime || 'image/jpeg'};base64,${data}`,
        },
      });
    }
    // The declared alternative to bytes: an `ImageContent.uri` (and its audio,
    // video and document twins). It is relayed as the part's URL rather than
    // fetched here, because a URL is a position every target this hop reaches
    // already has — the Completions `image_url`, the Responses `input_image`, and
    // the Claude image source, which fetches it itself under its SSRF guard.
    const uri = media?.uri;
    if (!claimed && typeof uri === 'string' && uri !== '') {
      claimed = true;
      imageParts.push({ type: 'image_url', image_url: { url: uri } });
    }
    if (!claimed) throw unexpressibleContentPart(p?.type, media !== undefined, at);
  }

  if (imageParts.length === 0) {
    if (textParts.length === 0) {
      // Every part was recognized but none carried content — a `thought:true`
      // marker list. The upstream would be handed an empty prompt for a message
      // the client did write.
      throw new ValidationError(
        `Interactions ${where} carries no text or media this conversion can express`,
      );
    }
    return textParts.join('');
  }
  const out: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string | BlobRef } }> = [];
  const text = textParts.join('');
  if (text !== '') out.push({ type: 'text', text });
  out.push(...imageParts);
  return out;
}

/** The refusal for a Content part this hop has no Completions position for. */
function unexpressibleContentPart(type: unknown, isMediaType: boolean, where: string): ValidationError {
  if (type === 'thought' || type === 'function_call' || type === 'function_result') {
    return new ValidationError(
      `Interactions ${where} part of type ${JSON.stringify(type)} needs a message of its own; ` +
      'send it as an input step rather than inside `content`',
    );
  }
  if (isMediaType) {
    return new ValidationError(
      `Interactions ${where} ${JSON.stringify(type)} part carries neither base64 \`data\` nor a \`uri\``,
    );
  }
  return new ValidationError(
    `Interactions ${where} part of type ${JSON.stringify(type)} has no Completions equivalent`,
  );
}

/** Map a Gemini guided-decoding mode/type onto the Completions vocabulary. */
function geminiToolChoiceMode(value: unknown): 'auto' | 'none' | 'required' | undefined {
  if (typeof value !== 'string') return undefined;
  switch (value.toLowerCase()) {
    case 'auto':
    case 'dynamic':
      return 'auto';
    case 'any':
    case 'validated':
      return 'required';
    case 'none':
      return 'none';
    default:
      return undefined;
  }
}

/**
 * Map a Gemini tool-choice value onto the Completions `tool_choice` vocabulary.
 *
 * Three spellings reach this: the Interactions `generation_config.tool_choice`
 * (bare enum, `{type, function}`, or `{mode, tools}`), generateContent's
 * `toolConfig.functionCallingConfig` (`{mode: 'AUTO'|'ANY'|'NONE',
 * allowedFunctionNames}`), and generateContent's own `tool_choice`. Completions
 * only has `'auto'`, `'none'`, `'required'` and a forced single function:
 *
 *   'auto' | 'dynamic' (undocumented)       → 'auto'
 *   'any' | 'validated'                     → 'required'
 *   'none'                                  → 'none'
 *   {function:{name}} / one-name allow-list → {type:'function', function:{name}}
 *   allow-list of 2+ names                  → 'required'  (looser: the model may
 *                                             call any declared tool, not only
 *                                             one of the listed ones)
 *   absent / unrecognized                   → undefined   (key omitted)
 *
 * `any` and `validated` are the same constraint in Gemini's vocabulary — the
 * model "is constrained to always predicting a function call" — which is
 * Completions' `'required'`: a tool call and no prose. The reverse converters
 * already read the pair that way (`claude-to-gemini.ts` sends `required` as ANY
 * with no allow-list), so carrying `any` as `'auto'` here lost the client's
 * constraint on the way in and contradicted the way back out. The remaining loss
 * is the allow-list itself: Completions cannot name a *set* of permitted
 * functions, only one.
 */
function geminiToolChoiceToOpenAI(toolChoice: unknown): unknown {
  if (typeof toolChoice === 'string') return geminiToolChoiceMode(toolChoice);
  if (!toolChoice || typeof toolChoice !== 'object') return undefined;
  const cfg = toolChoice as Record<string, unknown>;

  const fnName = (cfg.function as Record<string, unknown> | undefined)?.name;
  if (typeof fnName === 'string' && fnName !== '') {
    return { type: 'function', function: { name: fnName } };
  }

  // `allowedFunctionNames` is the generateContent spelling, `tools` the
  // Interactions one. An empty or absent list constrains nothing.
  const rawNames = Array.isArray(cfg.allowedFunctionNames) ? cfg.allowedFunctionNames : cfg.tools;
  const names = Array.isArray(rawNames) ? rawNames.filter(n => typeof n === 'string' && n !== '') : [];
  if (names.length === 1) return { type: 'function', function: { name: names[0] } };
  if (names.length > 1) return 'required';

  return geminiToolChoiceMode(cfg.type ?? cfg.mode);
}

/** A plain JSON object, or undefined for anything else (arrays included). */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * The Interactions `input`, in every shape the API declares
 * (`docs/api/interactions.md`: a string, a Content, an array of Content, an array
 * of Turn, or an object carrying `messages`) plus the *step* form a client may
 * send in place of Turns (`type: 'user_input'` / `'model_output'` standing in
 * for a Turn's `role`, and the tool and thought steps beside them).
 *
 * The discrimination mirrors `converters/interactions-to-gemini.ts`'s
 * `buildContents` — the same front door served by a native Gemini upstream — so
 * one body is read the same way on both routes. It matters most for the bare
 * `Content[]` form (the shape `interactions.md`'s own multimodal example uses),
 * which is *one* turn's part list, not one message per part: read as Turns it
 * produced a message whose role and content had both been dropped.
 *
 * The array's first entry decides how the whole array is read, as in
 * `buildContents`: a Turn carries `role`, a step carries one of the step `type`s,
 * anything else is a part list. A *step* list is read by `stepsToMessages`, which
 * gives a tool call and a thought the message of its own this wire needs — before
 * that, an array headed by anything but `user_input` / `model_output` was read as
 * a part list, matched no part, and became a single empty `content` (rule #8).
 *
 * A shape that yields no message is refused rather than half-read. That is what
 * the last branch protects: an unrecognized scalar used to fall through to
 * `String(content)`, putting `[object Object]` in the prompt, and an
 * unrecognized array became `messages: []` at the upstream.
 */
function interactionsInputToMessages(input: unknown): Array<Record<string, unknown>> {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }

  if (Array.isArray(input)) {
    if (input.length === 0) {
      throw new ValidationError('Interactions request `input` array must carry at least one content');
    }
    const first = asRecord(input[0]);
    if (first && 'role' in first) {
      return input.map(entry => turnToMessage(asRecord(entry), 'input[]'));
    }
    if (first && typeof first.type === 'string' && INTERACTIONS_STEP_TYPES.has(first.type)) {
      return stepsToMessages(input);
    }
    return [{ role: 'user', content: geminiPartsToOpenAIContent(input, '`input`') }];
  }

  const record = asRecord(input);
  if (record) {
    if (Array.isArray(record.messages)) {
      if (record.messages.length === 0) {
        throw new ValidationError(
          'Interactions request `input.messages` must contain at least one user or model message',
        );
      }
      // Passed through as the client wrote it: these already are Completions
      // messages, and a role the client left out is filled in later by
      // `defaultMissingOpenAIMessageRoles` on an openai-completions route.
      return record.messages as Array<Record<string, unknown>>;
    }
    if ('role' in record) {
      return [turnToMessage(record, 'input')];
    }
    if (typeof record.type === 'string' && INTERACTIONS_STEP_TYPES.has(record.type)) {
      return stepsToMessages([record]);
    }
    // A lone Content: one part, so one message holding it.
    if (typeof record.type === 'string') {
      return [{ role: 'user', content: geminiPartsToOpenAIContent([record], '`input`') }];
    }
  }

  throw new ValidationError(
    'Interactions request `input` must be a string, a Content, an array of Content or Turn, ' +
    'or an object with `messages`',
  );
}

/** A Turn: `role` plus `content` (a bare string, or a part list). */
function turnToMessage(turn: Record<string, unknown> | undefined, where: string): Record<string, unknown> {
  if (!turn) throw new ValidationError(`Interactions ${where} entry must be an object`);

  return {
    role: turn.role === 'model' ? 'assistant' : turn.role,
    content: contentToOpenAIContent(turn.content, where),
  };
}

/**
 * An `input` step list → the Completions messages that carry it.
 *
 * `user_input` and `model_output` are the client's and the model's turns. The
 * three remaining expressible steps have no Completions *part*: a
 * `function_call` is a message-level `tool_calls[]`, its `function_result` the
 * `role:'tool'` message that answers it, and a `thought` a message-level
 * `reasoning_content`. The hop above turns the first pair into the Responses
 * `function_call` / `function_call_output` items and the third into a `reasoning`
 * item, so all three reach an `openai-responses` upstream intact.
 *
 * A `thought` carries the reasoning of the turn it introduces, so it is folded
 * into that turn rather than given a message of its own — an assistant message
 * holding reasoning and no content is what the hop above would turn into an empty
 * message item. A thought with no assistant turn after it (before a
 * `user_input`, or at the end of the list) is carried as its own message: the
 * alternative is silently moving it across the client's turn.
 *
 * A step with no Completions spelling is refused by name (rule #8). Reading such
 * an array as a part list is what used to send the upstream an empty `content`
 * with the whole step missing and nothing said.
 */
function stepsToMessages(steps: unknown[]): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  let reasoning = '';

  /** Give whatever thought is pending to `message`, as its reasoning. */
  const attachReasoning = (message: Record<string, unknown>): void => {
    if (reasoning === '') return;
    message.reasoning_content = reasoning;
    reasoning = '';
  };

  /** Carry a pending thought as a message of its own — it belongs to no turn. */
  const flushReasoning = (): void => {
    if (reasoning === '') return;
    messages.push({ role: 'assistant', content: '', reasoning_content: reasoning });
    reasoning = '';
  };

  for (const entry of steps) {
    const step = asRecord(entry);
    if (!step) throw new ValidationError('Interactions input step must be an object');
    const where = `input step ${JSON.stringify(step.type)}`;

    switch (step.type) {
      case 'thought':
        reasoning += thoughtSummaryText(step.summary);
        break;

      case 'user_input':
        flushReasoning();
        messages.push({ role: 'user', content: contentToOpenAIContent(step.content, where) });
        break;

      case 'model_output': {
        const message: Record<string, unknown> = {
          role: 'assistant',
          content: contentToOpenAIContent(step.content, where),
        };
        attachReasoning(message);
        messages.push(message);
        break;
      }

      case 'function_call': {
        const message: Record<string, unknown> = {
          role: 'assistant',
          // `null`, not '', beside `tool_calls`: the reason
          // `claudeJsonToSyntheticCompletions` gives — upstreams reject the empty
          // string there, and the hop above reads null as "no message content".
          content: null,
          tool_calls: [functionCallToToolCall(step, where)],
        };
        attachReasoning(message);
        messages.push(message);
        break;
      }

      case 'function_result':
        messages.push({
          role: 'tool',
          tool_call_id: requireStepString(step.call_id, `${where}.call_id`),
          content: toolResultContent(step.result, where),
        });
        break;

      default:
        throw new ValidationError(
          `Interactions ${where} has no Completions equivalent; this route cannot replay it`,
        );
    }
  }

  flushReasoning();
  return messages;
}

/** A required, non-empty string field of an input step. */
function requireStepString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new ValidationError(`Interactions ${where} must be a non-empty string`);
  }
  return value;
}

/**
 * A `function_call` step → the Completions `tool_calls[]` entry carrying it. The
 * hop above maps it onto a Responses `function_call` item and uses `id` as that
 * item's `call_id`, which is how the matching `function_result` is paired.
 */
function functionCallToToolCall(step: Record<string, unknown>, where: string): Record<string, unknown> {
  const name = requireStepString(step.name, `${where}.name`);
  // Required by the spec, and the pairing above depends on it: inventing an id
  // would leave the call and its result unmatched at the upstream.
  const id = requireStepString(step.id, `${where}.id`);
  const args = JSON.stringify(functionArgs(step.arguments, `${where}.arguments`));
  return { id, type: 'function', function: { name, arguments: args } };
}

/**
 * A `function_result` step's `result` as the content of the `role:'tool'` message
 * that answers its call — the same three-way reading the `/v1/messages` hop gives
 * the same field: a string as it stands, anything else serialized.
 *
 * A part list is read as text, because that is what the hop above does with an
 * array tool result (`completions-to-responses.ts`). A part that is not text is
 * refused here rather than dropped by that extraction without a word (rule #8).
 */
function toolResultContent(result: unknown, where: string): string {
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    let text = '';
    for (let i = 0; i < result.length; i++) {
      const part = asRecord(result[i]);
      if (!part || typeof part.text !== 'string') {
        throw new ValidationError(
          `Interactions ${where}[${i}] part of type ${JSON.stringify(part?.type)} has no Completions ` +
          'tool-result position',
        );
      }
      text += part.text;
    }
    return text;
  }
  if (result === undefined) {
    throw new ValidationError(`Interactions ${where} must carry the tool call result`);
  }
  return JSON.stringify(result);
}

/**
 * The reasoning text of a `thought` step. The SDK declares `summary` a list of
 * Content (`ThoughtSummaryContent = ImageContent | TextContent`), while
 * `docs/api/interactions.md` declares it a `ThoughtSummary` object wrapping one
 * under `content`. Both are read: the two disagree, and each front door may be
 * sent the spelling its own doc describes.
 */
function thoughtSummaryText(summary: unknown): string {
  if (typeof summary === 'string') return summary;
  let parts: unknown[];
  if (Array.isArray(summary)) {
    parts = summary;
  } else {
    const content = asRecord(summary)?.content;
    if (content === undefined) return '';
    parts = Array.isArray(content) ? content : [content];
  }
  return parts
    .map(part => {
      const text = asRecord(part)?.text;
      return typeof text === 'string' ? text : '';
    })
    .join('');
}

/**
 * A Turn/step `content`: a bare string, or a part list. Anything else is refused
 * rather than stringified — `String({type:'text', …})` would put `[object
 * Object]` in the prompt the upstream reads.
 *
 * An *absent* content is not one of those: the SDK types a step's `content` as
 * optional (`UserInputStep.content?`), so a step that carries none is an empty
 * turn rather than a malformed one. An explicit empty *list* is still refused
 * — a client that wrote `content: []` wrote something the step cannot mean.
 */
function contentToOpenAIContent(
  content: unknown,
  where: string,
): string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string | BlobRef } }> {
  if (typeof content === 'string') return content;
  if (content === undefined) return '';
  if (Array.isArray(content)) {
    if (content.length === 0) {
      throw new ValidationError(`Interactions ${where}.content must carry at least one part`);
    }
    return geminiPartsToOpenAIContent(content, `${where}.content`);
  }
  throw new ValidationError(`Interactions ${where}.content must be a string or an array of Content parts`);
}

/**
 * The declared system prompt as text, in any spelling this front door is served:
 * the Interactions string, generateContent's `{parts:[{text}]}`, or a bare
 * `{text}`. Shared by both converters here, since the Interactions
 * `system_instruction` and generateContent's `systemInstruction` are the same
 * field and either body may reach either one. An unrecognized shape is refused
 * rather than dropped — a lost system prompt changes the answer (Rule #8).
 */
function systemInstructionToText(declared: unknown): string {
  if (declared === undefined || declared === null) return '';
  if (typeof declared === 'string') return declared;

  const record = asRecord(declared);
  if (record) {
    const parts = record.parts;
    if (Array.isArray(parts)) {
      return parts
        .map(part => {
          const text = asRecord(part)?.text;
          return typeof text === 'string' ? text : '';
        })
        .join('');
    }
    if (typeof record.text === 'string') return record.text;
  }
  throw new ValidationError('Interactions `system_instruction` must be a string or a text part list');
}

/**
 * Convert Gemini Interactions request to OpenAI format
 *
 * Carries every request-level field the Interactions body declares that has a
 * Completions spelling: the system prompt, the tool declarations, `stop_sequences`,
 * `tool_choice`, the `generation_config` sampling knobs (`temperature`, `top_p`,
 * `max_output_tokens`, `thinking_level`), `store`, `labels` (as `metadata`), and
 * `response_format` / `response_mime_type`. This matters because the body is
 * re-targeted to three upstream families — openai-completions natively,
 * anthropic-messages via `completionsToClaudeBody`, openai-responses via
 * `completionsToResponsesBody` — and whatever this hop drops is unreachable at every
 * one of them.
 *
 * `labels` is the one field that rides the intermediate and then stops: the
 * openai-completions target receives `metadata` natively, while both second hops drop
 * it — `completionsToClaudeBody` maps no metadata and Claude's `metadata` accepts only
 * `user_id`, and `completionsToResponsesBody` maps none either even though the
 * Responses API declares the field. `src/handlers/openai.ts` warns at those two hops
 * rather than dropping it in silence (rule #8).
 *
 * Still dropped here, as on the generateContent path: `seed` and the rest of
 * `generation_config` (`thinking_summaries`, `speech_config`), `background`,
 * `previous_interaction_id`, `response_modalities`, `cached_content`, `agent` /
 * `agent_config`, and the non-function tool families. `thinking_summaries` and the
 * tool families are expressible in the Responses API but have no Completions
 * spelling, so only a direct Interactions→Responses converter could reach them;
 * `seed` and `stop_sequences` are unreachable at a Responses target under either
 * design. See `docs/api/review-interactions-to-openai-responses-hops.md`.
 *
 * `options.logger` is optional and carries warnings only: rule #8 requires a
 * `labels` map that breaks its declared type to be reported rather than dropped in
 * silence, as the generateContent sibling reports an unpaired `functionResponse` id.
 */
export function convertGeminiInteractionsToOpenAI(
  geminiRequest: Record<string, unknown>,
  options?: { logger?: Logger; requestId?: string },
): Record<string, unknown> {
  const model = (geminiRequest.model as string) || 'gemini-no-id-at-proxy';

  // The Interactions `input`, or the generateContent `contents` a body reaching
  // this front door may carry instead (`isGeminiInteractionsRequest` accepts
  // either). `input` wins when both are present.
  let messages: Array<Record<string, unknown>> | undefined;
  if (geminiRequest.input !== undefined) {
    messages = interactionsInputToMessages(geminiRequest.input);
  } else if (Array.isArray(geminiRequest.contents)) {
    messages = (geminiRequest.contents as any[]).map((content: any) => ({
      role: content.role === 'model' ? 'assistant' : content.role,
      content: geminiPartsToOpenAIContent(content.parts, '`contents`'),
    }));
  }

  if (!messages) {
    throw new ValidationError('Invalid Gemini Interactions request format');
  }

  // `system_instruction` is a top-level string on the Interactions API, while
  // generateContent wraps it as `{parts:[{text}]}`; both forms become the
  // leading OpenAI system message (mirroring convertGeminiGenerateContentToOpenAI).
  const systemText = systemInstructionToText(
    geminiRequest.system_instruction ?? geminiRequest.systemInstruction,
  );
  if (systemText) {
    // New array, not unshift: `messages` may be the caller's own
    // `input.messages` array, which must not be mutated.
    messages = [{ role: 'system', content: systemText }, ...messages];
  }

  const result: Record<string, unknown> = {
    model,
    messages,
    stream: geminiRequest.stream || false,
  };

  // Convert Gemini tools to OpenAI tools[]. The Interactions API declares a flat
  // `{type:'function', name, description, parameters}` entry; a body that came
  // from the generateContent shape (or went through before_conversion) carries
  // `functionDeclarations`. Accept both. Non-function Gemini tools
  // (google_search, code_execution, …) have no Completions equivalent and are
  // still dropped, as on the generateContent path.
  const tools: unknown[] = [];
  if (Array.isArray(geminiRequest.tools)) {
    for (const tool of geminiRequest.tools as any[]) {
      const decls: any[] = Array.isArray(tool?.functionDeclarations)
        ? tool.functionDeclarations
        : typeof tool?.name === 'string' && tool.name !== '' ? [tool] : [];
      for (const fd of decls) {
        tools.push({
          type: 'function',
          function: {
            name: fd.name,
            description: fd.description,
            parameters: normalizeGeminiSchema(fd.parameters ?? { type: 'object', properties: {} }),
          },
        });
      }
    }
  }
  if (tools.length > 0) result.tools = tools;

  // `generation_config.stop_sequences` is the one generation knob with a
  // Completions equivalent here too. Snake_case is the Interactions spelling,
  // camelCase the generateContent one; both are read. Same trade-off as the
  // generateContent path: an openai-completions upstream takes `stop` natively
  // and anthropic-messages receives it as `stop_sequences`, while the
  // openai-responses hop still drops it (the Responses API has no such field).
  const config = (geminiRequest.generation_config ?? geminiRequest.generationConfig) as
    Record<string, unknown> | undefined;
  const stopSequences = config?.stop_sequences ?? config?.stopSequences;
  const stop = Array.isArray(stopSequences)
    ? stopSequences
    : typeof stopSequences === 'string' ? [stopSequences] : [];
  // An empty list means "no stop sequences"; emitting `stop: []` would be a new
  // wire value for an upstream that never saw the field.
  if (stop.length > 0) result.stop = stop;

  // `tool_choice` (Interactions) / `toolConfig.functionCallingConfig`
  // (generateContent shape). Only emitted when a tool survived the conversion:
  // a tool_choice naming no declared function is an upstream error, and one
  // sent alongside an empty tools list would be a new wire value for nothing.
  const toolChoice = geminiToolChoiceToOpenAI(
    config?.tool_choice
      ?? config?.toolChoice
      ?? (geminiRequest.toolConfig as Record<string, unknown> | undefined)?.functionCallingConfig,
  );
  if (tools.length > 0 && toolChoice !== undefined) result.tool_choice = toolChoice;

  // Sampling and budget knobs. Unlike `stop_sequences`, each of these has a
  // Completions spelling, so they ride the intermediate and the openai-responses
  // hop re-targets them (`completionsToResponsesBody`).
  if (typeof config?.temperature === 'number') result.temperature = config.temperature;
  if (typeof config?.top_p === 'number') result.top_p = config.top_p;
  // `max_tokens` is the spelling `convertClaudeToOpenAIRequest` already emits, and
  // the one both the per-route cap and the openai-responses hop read.
  if (typeof config?.max_output_tokens === 'number') result.max_tokens = config.max_output_tokens;

  // `thinking_level` (`minimal` | `low` | `medium` | `high`) is the same four values
  // as the Responses `reasoning.effort` enum, and a subset of what a Completions
  // upstream accepts as `reasoning_effort`, so it passes through verbatim. The
  // `OpenAIRequest` union under-declares it (`low` | `medium` | `high` | `max`) —
  // as it does `store` below — so the schema dump, not the TS type, is the authority.
  const thinkingLevel = config?.thinking_level ?? config?.thinkingLevel;
  if (typeof thinkingLevel === 'string') result.reasoning_effort = thinkingLevel;

  // `store` is the Interactions input-only retention flag ("whether to store the
  // response and request for later retrieval"). Chat Completions spells it the same
  // way (`docs/api/list_of_api_and_schema.md:203`), so it needs no side channel: an
  // openai-completions upstream receives a field it already has, and the
  // openai-responses hop re-emits it under the same name. Omitted when the client
  // did not send it, so an upstream's own default still applies.
  if (typeof geminiRequest.store === 'boolean') result.store = geminiRequest.store;

  // `labels` is the Interactions request's user-defined metadata map
  // (`@google/genai` declares it `labels?: {[k: string]: string}` on
  // CreateModelInteraction / CreateAgentInteraction; `docs/api/interactions.md`
  // predates the field). Chat Completions carries the same channel under the name
  // `metadata` — the Completions spelling `docs/api/list_of_api_and_schema.md:203`
  // lists and `responses-to-completions.ts:219` already maps in the other direction —
  // so the two spellings ride one in-band field rather than a side channel. It is an
  // attribution channel the model never reads, and OpenAI retains it only under
  // `store`, which the block above forwards. A non-empty map only: `labels: {}` means
  // "no labels", and `metadata: {}` would be a new wire value for an upstream that
  // never saw the field (the same reason `stop: []` is omitted above).
  const labels = geminiRequest.labels;
  if (labels !== undefined) {
    const entries = labels !== null && typeof labels === 'object' && !Array.isArray(labels)
      ? Object.entries(labels as Record<string, unknown>)
      : null;
    if (entries === null || entries.some(([, value]) => typeof value !== 'string')) {
      // Rule #8: the spec types this field as map<string,string>, so a body that
      // breaks the declared type is reported rather than forwarded half-read. The
      // request is still served — labels are attribution metadata, not model input,
      // so refusing the turn over them would cost the client more than it protects.
      options?.logger?.warn(
        options?.requestId ?? 'unknown',
        `[gemini->openai] labels is not a map of strings (got ${JSON.stringify(labels).substring(0, 200)}); ` +
        `not forwarded as metadata`,
      );
    } else if (entries.length > 0) {
      result.metadata = Object.fromEntries(entries);
    }
  }

  // Structured output. The Interactions field carries the JSON schema itself, while
  // the Completions spelling wraps it in a named `json_schema` — the shape
  // `completionsToResponsesBody` unwraps back into the Responses `text.format`,
  // using the same default name `responses-to-completions.ts:203` uses in reverse.
  // `response_mime_type: 'application/json'` without a schema is the schema-less JSON
  // mode; any other mime type has no Completions equivalent and is left alone.
  const responseFormat = geminiRequest.response_format;
  if (responseFormat && typeof responseFormat === 'object' && !Array.isArray(responseFormat)) {
    result.response_format = {
      type: 'json_schema',
      json_schema: { name: 'response', schema: responseFormat },
    };
  } else if (geminiRequest.response_mime_type === 'application/json') {
    result.response_format = { type: 'json_object' };
  }

  return result;
}

/**
 * Recursively normalize Gemini schema type names (uppercase) to JSON Schema
 * (lowercase) so OpenAI-compatible upstreams accept the function parameters.
 * e.g. "STRING" → "string", "OBJECT" → "object"
 */
function normalizeGeminiSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(normalizeGeminiSchema);
  const out: Record<string, any> = {};
  for (const key of Object.keys(schema)) {
    if (key === 'type' && typeof schema[key] === 'string') {
      out[key] = (schema[key] as string).toLowerCase();
    } else {
      out[key] = normalizeGeminiSchema(schema[key]);
    }
  }
  return out;
}

/**
 * Convert Gemini generateContent request to OpenAI format
 *
 * `options.logger` is optional and carries warnings only: Rule #8 requires a
 * `functionResponse` whose supplied `id` matches no `functionCall` in the same
 * body to be reported rather than paired by position in silence.
 */
export function convertGeminiGenerateContentToOpenAI(
  geminiRequest: Record<string, unknown>,
  options?: { logger?: Logger; requestId?: string },
): Record<string, unknown> {
  const model = (geminiRequest.model as string) || 'gemini-no-id-at-proxy';

  // Handle contents format
  if (Array.isArray(geminiRequest.contents)) {
    const messages: Record<string, unknown>[] = [];

    // Extract systemInstruction and prepend as OpenAI system message.
    // `systemInstruction` is generateContent's spelling and `system_instruction`
    // the Interactions one — the same field, and a body reaching this converter
    // may spell it either way.
    const systemText = systemInstructionToText(
      geminiRequest.systemInstruction ?? geminiRequest.system_instruction,
    );
    if (systemText) {
      messages.push({ role: 'system', content: systemText });
    }

    // Track the last emitted tool_calls so tool results can recover the correct
    // id+name — by the client's own id when it carried one, by position otherwise.
    let lastToolCalls: Array<{ id: string; name: string }> = [];

    for (const content of geminiRequest.contents as any[]) {
      const role = content.role === 'model' ? 'assistant' : content.role;
      const parts: any[] = content.parts ?? [];

      const funcCallParts = parts.filter((p: any) => p.functionCall);
      const funcRespParts = parts.filter((p: any) => p.functionResponse);
      // Separate thinking (thought:true) from regular text so they can be
      // reconstructed as proper Claude thinking blocks by completionsToClaudeBody.
      // DeepSeek requires `reasoning_content` to be round-tripped on any
      // assistant turn that performed a tool call — see
      // docs/review_of_antigravity_gemini_with_ds_tools.md.
      const thinkingContent = parts.filter((p: any) => p.thought && p.text).map((p: any) => p.text as string).join('');
      const thinkingSignature = parts.find((p: any) => p.thought && p.text && typeof p.thoughtSignature === 'string' && p.thoughtSignature !== '')?.thoughtSignature as string | undefined;
      const textContent = parts.filter((p: any) => p.text && !p.thought).map((p: any) => p.text as string).join('');

      if (funcCallParts.length > 0) {
        // Model turn: convert functionCall parts to OpenAI tool_calls. A client
        // that tagged its call with an `id` keeps it, so the matching
        // functionResponse can be paired by id; the synthesized id stays the
        // fallback for the (common) client that carries none.
        lastToolCalls = funcCallParts.map((p: any, i: number) => ({
          id: typeof p.functionCall.id === 'string' && p.functionCall.id !== ''
            ? p.functionCall.id
            : `call_${p.functionCall.name}_${i}`,
          name: p.functionCall.name,
        }));
        const msg: Record<string, unknown> = {
          role: 'assistant',
          content: textContent || null,
          tool_calls: lastToolCalls.map((tc, i) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(funcCallParts[i].functionCall.args ?? {}),
            },
          })),
        };
        if (thinkingContent) {
          msg.reasoning_content = thinkingContent;
          if (thinkingSignature) msg.reasoning_signature = thinkingSignature;
        }
        messages.push(msg);
      } else if (funcRespParts.length > 0) {
        // User turn: convert functionResponse parts to OpenAI tool messages.
        // Prefer the id the client carried on the response: parallel tool calls
        // complete in whatever order they finish, which need not match call
        // order, and position alone would attach each result to the wrong call.
        for (let i = 0; i < funcRespParts.length; i++) {
          const p = funcRespParts[i];
          const respId = typeof p.functionResponse.id === 'string' ? p.functionResponse.id : '';
          const byId = respId ? lastToolCalls.find(tc => tc.id === respId) : undefined;
          // Rule #8: a supplied id that matches no call is evidence that position
          // is NOT the pairing — report it rather than file the result silently
          // under whichever call happens to sit at this index. Positional pairing
          // stays the fallback (and remains the whole behavior when the client
          // carries no ids): rejecting instead would turn a mispaired result into
          // a hard upstream 400 for every client that mints its own response ids.
          if (respId && !byId) {
            options?.logger?.warn(
              options?.requestId ?? 'unknown',
              `[gemini->openai] functionResponse id ${JSON.stringify(respId)} matches no functionCall in this ` +
              `request (calls: ${lastToolCalls.map(tc => tc.id).join(', ') || 'none'}); pairing by position ` +
              `instead, which may attach this result to the wrong call`,
            );
          }
          const matched = byId ?? lastToolCalls[i];
          messages.push({
            role: 'tool',
            tool_call_id: matched?.id ?? `call_${p.functionResponse.name}_${i}`,
            name: matched?.name ?? p.functionResponse.name,
            content: JSON.stringify(p.functionResponse.response ?? {}),
          });
        }
        lastToolCalls = [];
      } else {
        // Collect image parts. Gemini SDK accepts both snake_case
        // (inline_data.mime_type) and camelCase (inlineData.mimeType); emit
        // them as OpenAI image_url data-URI parts. When a turn has any image
        // part, content becomes an array mixing text and image_url parts
        // (matching src/converters/claude-to-openai.ts:54-60).
        const imageParts = parts
          .map((p: any) => {
            const inline = p.inline_data ?? p.inlineData;
            if (!inline) return null;
            const mime = inline.mime_type ?? inline.mimeType;
            const data: unknown = inline.data;
            if (typeof data !== 'string' && !isBlobRef(data)) return null;
            if (typeof data === 'string' && data === '') return null;
            return {
              type: 'image_url' as const,
              image_url: {
                url: isBlobRef(data)
                  ? rebindBlobRef(data, 'chat-image-url', `data:${mime || 'image/jpeg'};base64,`)
                  : `data:${mime || 'image/jpeg'};base64,${data}`,
              },
            };
          })
          .filter((p: any): p is { type: 'image_url'; image_url: { url: string | BlobRef } } => p !== null);

        let msg: Record<string, unknown>;
        if (imageParts.length === 0) {
          msg = { role, content: textContent };
        } else {
          const contentArr: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string | BlobRef } }> = [];
          if (textContent) contentArr.push({ type: 'text', text: textContent });
          for (const ip of imageParts) contentArr.push(ip);
          msg = { role, content: contentArr };
        }
        if (thinkingContent) {
          msg.reasoning_content = thinkingContent;
          if (thinkingSignature) msg.reasoning_signature = thinkingSignature;
        }
        messages.push(msg);
      }
    }

    // Convert Gemini tools[].functionDeclarations to OpenAI tools[]
    const tools: unknown[] = [];
    if (Array.isArray(geminiRequest.tools)) {
      for (const tool of geminiRequest.tools as any[]) {
        if (Array.isArray(tool.functionDeclarations)) {
          for (const fd of tool.functionDeclarations) {
            tools.push({
              type: 'function',
              function: {
                name: fd.name,
                description: fd.description,
                parameters: normalizeGeminiSchema(fd.parameters ?? { type: 'object', properties: {} }),
              },
            });
          }
        }
      }
    }

    // Check for stream parameter in both top-level and generationConfig
    const config = geminiRequest.generationConfig as Record<string, unknown> | undefined;
    const stream = geminiRequest.stream === true || config?.stream === true;

    const result: Record<string, unknown> = { model, messages, stream };
    if (tools.length > 0) result.tools = tools;

    // `generationConfig.stopSequences` is the one generation knob with a
    // Completions equivalent, and the two cross-mode targets this body gets
    // re-targeted to can carry it: an openai-completions upstream takes `stop`
    // natively, and an anthropic-messages upstream receives it as `stop_sequences`
    // via `completionsToClaudeBody`. The openai-responses hop still drops it — the
    // Responses API has no stop-sequence field (`completionsToResponsesBody`).
    const stopSequences = config?.stopSequences;
    const stop = Array.isArray(stopSequences)
      ? stopSequences
      : typeof stopSequences === 'string' ? [stopSequences] : [];
    // An empty list means "no stop sequences"; emitting `stop: []` would be a new
    // wire value for an upstream that never saw the field.
    if (stop.length > 0) result.stop = stop;

    // `toolConfig.functionCallingConfig` (native spelling) or `tool_choice`.
    // Same gate as the Interactions path: no surviving tool, no tool_choice.
    const toolChoice = geminiToolChoiceToOpenAI(
      (geminiRequest.toolConfig as Record<string, unknown> | undefined)?.functionCallingConfig
        ?? config?.tool_choice,
    );
    if (tools.length > 0 && toolChoice !== undefined) result.tool_choice = toolChoice;
    return result;
  }

  throw new Error('Invalid Gemini generateContent request format');
}

export function defaultMissingOpenAIMessageRoles(openaiRequest: Record<string, unknown>): void {
  if (!Array.isArray(openaiRequest.messages)) return;

  openaiRequest.messages = openaiRequest.messages.map(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
    const msg = message as Record<string, unknown>;
    return msg.role == null ? { ...msg, role: 'user' } : msg;
  });
}
