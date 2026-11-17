import type { Logger } from '../types/shared.js';
import { ValidationError } from '../utils/errors.js';
import { stringify } from '../utils/stringify.js';

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
  options?.logger?.warn(options.requestId ?? '', '[generateContent->interactions-request] ' + message);
}

function mediaType(mimeType: string): string | undefined {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType === 'application/pdf') return 'document';
  return undefined;
}

function mediaPart(part: Record<string, unknown>, where: string): Record<string, unknown> | undefined {
  const inline = asRecord(part.inlineData ?? part.inline_data);
  const file = asRecord(part.fileData ?? part.file_data);
  const source = inline ?? file;
  if (!source) return undefined;
  const mime = source.mimeType ?? source.mime_type;
  const kind = typeof mime === 'string' ? mediaType(mime) : undefined;
  if (typeof mime !== 'string' || !kind) throw new ValidationError(`${where} has unsupported media mime type ${stringify(mime)}`);
  const resolution = asRecord(part.mediaResolution)?.level;
  const output: Record<string, unknown> = {
    type: kind, mime_type: mime,
    ...(typeof resolution === 'string' && resolution !== 'MEDIA_RESOLUTION_UNSPECIFIED'
      ? { resolution: resolution.replace(/^MEDIA_RESOLUTION_/, '').toLowerCase() }
      : {}),
  };
  if (inline) output.data = inline.data;
  else output.uri = file?.fileUri ?? file?.file_uri;
  return output;
}

function appendTurn(
  input: Array<Record<string, unknown>>,
  content: Record<string, unknown>,
  contentIndex: number,
): void {
  const role = content.role === 'model' ? 'model_output' : 'user_input';
  const parts = Array.isArray(content.parts) ? content.parts : [];
  let ordinary: Array<Record<string, unknown>> = [];
  let codeCallId: string | undefined;
  const flush = (): void => {
    if (ordinary.length === 0) return;
    input.push({ type: role, content: ordinary });
    ordinary = [];
  };
  for (const [partIndex, value] of parts.entries()) {
    const part = asRecord(value);
    if (!part) throw new ValidationError(`contents[${contentIndex}].parts[${partIndex}] must be an object`);
    const where = `contents[${contentIndex}].parts[${partIndex}]`;
    const signature = typeof part.thoughtSignature === 'string' && part.thoughtSignature !== ''
      ? { signature: part.thoughtSignature }
      : {};
    if (part.thought === true) {
      flush();
      input.push({
        type: 'thought',
        ...(typeof part.text === 'string' && part.text ? { summary: [{ type: 'text', text: part.text }] } : {}),
        ...signature,
      });
      continue;
    }
    if (typeof part.text === 'string') {
      ordinary.push({ type: 'text', text: part.text });
      continue;
    }
    const media = mediaPart(part, where);
    if (media) {
      ordinary.push(media);
      continue;
    }
    const call = asRecord(part.functionCall ?? part.function_call);
    if (call) {
      flush();
      const id = typeof call.id === 'string' && call.id !== '' ? call.id : `call_${contentIndex}_${partIndex}`;
      input.push({
        type: 'function_call', id,
        name: typeof call.name === 'string' ? call.name : '',
        arguments: asRecord(call.args) ?? {},
        ...signature,
      });
      continue;
    }
    const result = asRecord(part.functionResponse ?? part.function_response);
    if (result) {
      flush();
      const response = asRecord(result.response);
      input.push({
        type: 'function_result',
        call_id: typeof result.id === 'string' && result.id !== '' ? result.id : '',
        name: typeof result.name === 'string' ? result.name : '',
        result: typeof response?.content === 'string' ? response.content : stringify(response ?? result.response ?? ''),
        ...signature,
      });
      continue;
    }
    const executable = asRecord(part.executableCode ?? part.executable_code);
    if (executable) {
      flush();
      codeCallId = `code_call_${contentIndex}_${partIndex}`;
      input.push({
        type: 'code_execution_call', id: codeCallId,
        arguments: {
          language: typeof executable.language === 'string' ? executable.language.toLowerCase() : 'python',
          code: typeof executable.code === 'string' ? executable.code : '',
        },
        ...signature,
      });
      continue;
    }
    const codeResult = asRecord(part.codeExecutionResult ?? part.code_execution_result);
    if (codeResult) {
      flush();
      input.push({
        type: 'code_execution_result', call_id: codeCallId ?? `code_call_${contentIndex}_${Math.max(0, partIndex - 1)}`,
        result: typeof codeResult.output === 'string' ? codeResult.output : stringify(codeResult.output),
        is_error: codeResult.outcome !== 'OUTCOME_OK',
        ...signature,
      });
      codeCallId = undefined;
      continue;
    }
    throw new ValidationError(`${where} has no Interactions Content equivalent`);
  }
  flush();
}

export function generateContentToInteractionsBody(
  request: Record<string, unknown>,
  model: string,
  options?: ConversionOptions,
): Record<string, unknown> {
  if (!Array.isArray(request.contents)) throw new ValidationError('generateContent contents must be an array');
  const input: Array<Record<string, unknown>> = [];
  request.contents.forEach((content, index) => {
    const turn = asRecord(content);
    if (!turn) throw new ValidationError(`contents[${index}] must be an object`);
    appendTurn(input, turn, index);
  });
  if (input.length === 0) throw new ValidationError('generateContent request produced no Interactions input');

  const system = asRecord(request.systemInstruction ?? request.system_instruction);
  const systemText = typeof request.system_instruction === 'string'
    ? request.system_instruction
    : Array.isArray(system?.parts)
      ? system.parts.map(asRecord).map(part => typeof part?.text === 'string' ? part.text : '').join('')
      : typeof system?.text === 'string' ? system.text : '';

  const tools: Array<Record<string, unknown>> = [];
  for (const [index, value] of (Array.isArray(request.tools) ? request.tools : []).entries()) {
    const tool = asRecord(value);
    if (!tool) throw new ValidationError(`tools[${index}] must be an object`);
    if (Array.isArray(tool.functionDeclarations)) {
      for (const declaration of tool.functionDeclarations) {
        const fn = asRecord(declaration);
        if (!fn || typeof fn.name !== 'string' || !fn.name) throw new ValidationError(`tools[${index}] function requires name`);
        tools.push({
          type: 'function', name: fn.name,
          ...(fn.description !== undefined ? { description: fn.description } : {}),
          parameters: fn.parameters ?? { type: 'object', properties: {} },
        });
      }
    } else if (tool.googleSearch !== undefined) {
      const search = asRecord(tool.googleSearch);
      const types = asRecord(search?.searchTypes);
      const searchTypes = [
        ...(types?.webSearch !== undefined ? ['web_search'] : []),
        ...(types?.imageSearch !== undefined ? ['image_search'] : []),
      ];
      tools.push({ type: 'google_search', ...(searchTypes.length > 0 ? { search_types: searchTypes } : {}) });
    } else if (tool.codeExecution !== undefined) tools.push({ type: 'code_execution' });
    else if (tool.urlContext !== undefined) tools.push({ type: 'url_context' });
    else if (tool.computerUse !== undefined) {
      const computer = asRecord(tool.computerUse);
      tools.push({
        type: 'computer_use',
        ...(typeof computer?.environment === 'string' ? { environment: computer.environment } : {}),
        ...(Array.isArray(computer?.excludedPredefinedFunctions) ? { excluded_predefined_functions: computer.excludedPredefinedFunctions } : {}),
      });
    } else if (tool.googleMaps !== undefined) {
      const maps = asRecord(tool.googleMaps);
      tools.push({ type: 'google_maps', ...(typeof maps?.enableWidget === 'boolean' ? { enable_widget: maps.enableWidget } : {}) });
    } else if (tool.retrieval !== undefined) {
      const vertex = asRecord(asRecord(tool.retrieval)?.vertexAiSearch);
      const specs = Array.isArray(vertex?.dataStoreSpecs) ? vertex.dataStoreSpecs : [];
      const datastores = specs.map(asRecord).map(spec => spec?.dataStore).filter((value): value is string => typeof value === 'string');
      if (typeof vertex?.datastore === 'string') datastores.push(vertex.datastore);
      tools.push({
        type: 'retrieval', retrieval_types: ['vertex_ai_search'],
        vertex_ai_search_config: {
          ...(typeof vertex?.engine === 'string' ? { engine: vertex.engine } : {}),
          ...(datastores.length > 0 ? { datastores } : {}),
        },
      });
    } else {
      warn(options, `tools[${index}] has no Interactions equivalent; dropped`);
    }
  }

  const config = asRecord(request.generationConfig ?? request.generation_config) ?? {};
  const generation: Record<string, unknown> = {};
  for (const [source, target] of [
    ['temperature', 'temperature'], ['topP', 'top_p'], ['top_p', 'top_p'], ['seed', 'seed'],
    ['maxOutputTokens', 'max_output_tokens'], ['max_output_tokens', 'max_output_tokens'],
  ] as const) {
    if (typeof config[source] === 'number') generation[target] = config[source];
  }
  const stop = config.stopSequences ?? config.stop_sequences;
  if (Array.isArray(stop) && stop.length > 0) generation.stop_sequences = stop;
  const thinking = asRecord(config.thinkingConfig);
  if (typeof thinking?.thinkingLevel === 'string') generation.thinking_level = thinking.thinkingLevel.toLowerCase();
  if (thinking?.includeThoughts === true) generation.thinking_summaries = 'auto';
  else if (thinking?.includeThoughts === false) generation.thinking_summaries = 'none';
  const image = asRecord(config.imageConfig);
  if (image) generation.image_config = {
    ...(image.aspectRatio !== undefined ? { aspect_ratio: image.aspectRatio } : {}),
    ...(image.imageSize !== undefined ? { image_size: image.imageSize } : {}),
  };

  const functionCalling = asRecord(asRecord(request.toolConfig)?.functionCallingConfig);
  if (functionCalling) {
    const mode = functionCalling.mode;
    const names = Array.isArray(functionCalling.allowedFunctionNames)
      ? functionCalling.allowedFunctionNames.filter((name): name is string => typeof name === 'string')
      : [];
    generation.tool_choice = names.length > 0
      ? { allowed_tools: { mode: mode === 'AUTO' ? 'auto' : 'validated', tools: names } }
      : mode === 'AUTO' ? 'auto' : mode === 'NONE' ? 'none' : 'any';
  }
  const latLng = asRecord(asRecord(request.toolConfig)?.retrievalConfig)?.latLng;
  const maps = tools.find(tool => tool.type === 'google_maps');
  if (maps && asRecord(latLng)) {
    if (typeof asRecord(latLng)?.latitude === 'number') maps.latitude = asRecord(latLng)?.latitude;
    if (typeof asRecord(latLng)?.longitude === 'number') maps.longitude = asRecord(latLng)?.longitude;
  }

  const body: Record<string, unknown> = {
    model,
    input,
    ...(systemText ? { system_instruction: systemText } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(Object.keys(generation).length > 0 ? { generation_config: generation } : {}),
    ...(request.stream === true ? { stream: true } : {}),
  };
  const modalities = config.responseModalities ?? request.response_modalities;
  if (Array.isArray(modalities)) body.response_modalities = modalities.map(entry => String(entry).toLowerCase());
  const schema = config.responseJsonSchema ?? config.responseSchema;
  if (asRecord(schema)) body.response_format = schema;
  else if (config.responseMimeType === 'application/json') body.response_format = { type: 'object' };
  if (request.cachedContent !== undefined) warn(options, 'cachedContent has no field in the new Interactions contract; dropped');
  return body;
}
