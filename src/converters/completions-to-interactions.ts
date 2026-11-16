import type { OpenAIContent, OpenAIMessage } from '../types/openai.js';
import { isBlobRef, type BlobRef } from '../utils/blob-refs.js';
import { ValidationError } from '../utils/errors.js';
import { stringify } from '../utils/stringify.js';
import { decodeDataUriOrRef } from './claude-to-gemini.js';
import { openAIContentToText } from './completions-to-responses.js';
import { parseToolArguments } from './openai-to-gemini.js';

function contentToInteractionParts(content: OpenAIContent | null | undefined, where: string): Array<Record<string, unknown>> {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];
  if (!Array.isArray(content)) throw new ValidationError(`${where} must be a string or an array`);

  return content.map((part, index) => {
    const at = `${where}[${index}]`;
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image_url') {
      const image = part.image_url as { url?: string | BlobRef } | string | undefined;
      const url = typeof image === 'string' ? image : image?.url;
      if (typeof url === 'string' && !url.startsWith('data:')) return { type: 'image', uri: url };
      if (typeof url === 'string' || isBlobRef(url)) {
        const decoded = decodeDataUriOrRef(url);
        return { type: 'image', mime_type: decoded.mime_type, data: decoded.data };
      }
      throw new ValidationError(`${at}.image_url.url must be a URL or data URI`);
    }
    throw new ValidationError(`${at} type ${stringify(part.type)} has no Interactions Content equivalent`);
  });
}

function thoughtStep(text: unknown, signature?: unknown): Record<string, unknown> | undefined {
  const summary = typeof text === 'string' && text !== '' ? [{ type: 'text', text }] : [];
  const signed = typeof signature === 'string' && signature !== '';
  if (summary.length === 0 && !signed) return undefined;
  return { type: 'thought', summary, ...(signed ? { signature } : {}) };
}

function completionsToolChoiceToInteractions(toolChoice: unknown): unknown {
  if (toolChoice === 'auto' || toolChoice === 'none') return toolChoice;
  if (toolChoice === 'required') return 'any';
  if (toolChoice && typeof toolChoice === 'object') {
    const choice = toolChoice as Record<string, unknown>;
    const name = (choice.function as Record<string, unknown> | undefined)?.name;
    if (typeof name === 'string' && name !== '') {
      return { allowed_tools: { mode: 'validated', tools: [name] } };
    }
  }
  return undefined;
}

export function completionsToInteractionsBody(
  completions: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const messages = (completions.messages as OpenAIMessage[] | undefined) ?? [];
  const input: Array<Record<string, unknown>> = [];
  const instructions = messages
    .filter(message => message.role === 'system' || message.role === 'developer')
    .map(message => openAIContentToText(message.content))
    .filter(text => text !== '')
    .join('\n');

  for (const [index, message] of messages.entries()) {
    const where = `messages[${index}]`;
    if (message.role === 'system' || message.role === 'developer') continue;
    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || message.tool_call_id === '') {
        throw new ValidationError(`${where}.tool_call_id is required for an Interactions function_result`);
      }
      input.push({
        type: 'function_result',
        call_id: message.tool_call_id,
        ...(message.name ? { name: message.name } : {}),
        result: typeof message.content === 'string' ? message.content : stringify(message.content ?? ''),
      });
      continue;
    }

    if (message.role === 'assistant') {
      const record = message as unknown as Record<string, unknown>;
      const reasoning = thoughtStep(record.reasoning_content, record.reasoning_signature);
      if (reasoning) input.push(reasoning);
      if (Array.isArray(message.content)) {
        for (const [partIndex, part] of message.content.entries()) {
          if (part.type === 'thinking') {
            const thought = thoughtStep(part.thinking, part.signature);
            if (thought) input.push(thought);
          } else {
            const converted = contentToInteractionParts([part], `${where}.content[${partIndex}]`);
            input.push(...converted.map(content => ({ type: 'model_output', content: [content] })));
          }
        }
      } else {
        const content = contentToInteractionParts(message.content, `${where}.content`);
        if (content.length > 0) input.push({ type: 'model_output', content });
      }
      for (const call of message.tool_calls ?? []) {
        if (!call.id || !call.function?.name) {
          throw new ValidationError(`${where}.tool_calls entries require id and function.name`);
        }
        input.push({
          type: 'function_call',
          id: call.id,
          name: call.function.name,
          arguments: parseToolArguments(call.function.arguments),
        });
      }
      continue;
    }

    if (message.role === 'user') {
      input.push({ type: 'user_input', content: contentToInteractionParts(message.content, `${where}.content`) });
      continue;
    }
    throw new ValidationError(`${where}.role ${stringify(message.role)} has no Interactions input equivalent`);
  }

  if (input.length === 0) throw new ValidationError('Interactions input requires at least one non-system message');

  const generationConfig: Record<string, unknown> = {};
  if (typeof completions.temperature === 'number') generationConfig.temperature = completions.temperature;
  if (typeof completions.top_p === 'number') generationConfig.top_p = completions.top_p;
  if (typeof completions.seed === 'number') generationConfig.seed = completions.seed;
  const maxTokens = completions.max_completion_tokens ?? completions.max_tokens;
  if (typeof maxTokens === 'number') generationConfig.max_output_tokens = maxTokens;
  if (typeof completions.stop === 'string') generationConfig.stop_sequences = [completions.stop];
  else if (Array.isArray(completions.stop)) generationConfig.stop_sequences = completions.stop;
  if (typeof completions.reasoning_effort === 'string') {
    generationConfig.thinking_level = completions.reasoning_effort === 'max' ? 'high' : completions.reasoning_effort;
  }

  const body: Record<string, unknown> = {
    model,
    input,
    ...(instructions !== '' ? { system_instruction: instructions } : {}),
    ...(completions.stream === true ? { stream: true } : {}),
    ...(typeof completions.store === 'boolean' ? { store: completions.store } : {}),
  };
  if (completions.metadata !== undefined) body.labels = completions.metadata;
  if (Object.keys(generationConfig).length > 0) body.generation_config = generationConfig;

  if (Array.isArray(completions.tools)) {
    body.tools = completions.tools.map((tool, index) => {
      const fn = (tool as Record<string, unknown>).function as Record<string, unknown> | undefined;
      if ((tool as Record<string, unknown>).type !== 'function' || !fn || typeof fn.name !== 'string' || fn.name === '') {
        throw new ValidationError(`tools[${index}] must be a named function for an Interactions upstream`);
      }
      return {
        type: 'function',
        name: fn.name,
        ...(fn.description !== undefined ? { description: fn.description } : {}),
        parameters: fn.parameters ?? { type: 'object', properties: {} },
      };
    });
    const toolChoice = completionsToolChoiceToInteractions(completions.tool_choice);
    if (toolChoice !== undefined && (body.tools as unknown[]).length > 0) generationConfig.tool_choice = toolChoice;
  }

  const responseFormat = completions.response_format as Record<string, unknown> | undefined;
  if (responseFormat?.type === 'json_schema') {
    const schema = (responseFormat.json_schema as Record<string, unknown> | undefined)?.schema;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      throw new ValidationError('response_format.json_schema.schema is required for an Interactions upstream');
    }
    body.response_format = schema;
    body.response_mime_type = 'application/json';
  } else if (responseFormat?.type === 'json_object') {
    body.response_mime_type = 'application/json';
  } else if (responseFormat?.type === 'text') {
    body.response_mime_type = 'text/plain';
  }

  if (generationConfig.tool_choice !== undefined) body.generation_config = generationConfig;
  return body;
}
