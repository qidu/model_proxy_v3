/**
 * Embeddings API handler for Claude Proxy v3
 *
 * Proxies /v1/embeddings requests to the upstream OpenAI-compatible API.
 *
 * `upstreamMode` selects the upstream wire shape (see EMBEDDING_UPSTREAM_MODES).
 * "ollama-embed" targets Ollama's native POST /api/embed, whose request and
 * response both differ from the OpenAI shape: see toOllamaEmbedRequest() and
 * fromOllamaEmbedResponse() below.
 */

import type { Env, Logger } from '../types/shared.js';
import { createErrorResponse } from '../utils/errors.js';
import { addForwardedHeaders } from '../utils/routing.js';
import { createUpstreamAbortSignal, getUpstreamBodyTimeoutMs } from '../utils/fetch-timeout.js';

/**
 * Reshape an OpenAI `/v1/embeddings` body into Ollama's `POST /api/embed` body.
 *
 * Both take `model` and `input`, and `dimensions` carries over. `truncate`,
 * `keep_alive` and `options` are Ollama-native with no OpenAI equivalent, but are
 * forwarded when present: `options.num_ctx` is the only way for a caller to stop
 * a long input from being truncated at the model's context window. OpenAI-only
 * `encoding_format` and `user` are not sent (the caller rejects base64 before
 * this runs; `user` is advisory and Ollama's own /v1/embeddings drops it too).
 */
function toOllamaEmbedRequest(body: Record<string, unknown>): Record<string, unknown> {
  const converted: Record<string, unknown> = { model: body.model, input: body.input };
  for (const field of ['dimensions', 'truncate', 'keep_alive', 'options']) {
    if (body[field] !== undefined) converted[field] = body[field];
  }
  return converted;
}

/**
 * Reshape Ollama's `POST /api/embed` response into the OpenAI embeddings shape.
 *
 * Ollama returns `{ model, embeddings: [[number]], prompt_eval_count, ... }`;
 * callers of /v1/embeddings expect `{ object, data[], model, usage }`. Usage
 * mirrors Ollama's own /v1/embeddings translation, which reports the prompt
 * token count as both prompt and total tokens.
 *
 * Returns null when `embeddings` is missing or malformed, so the caller raises a
 * 502 instead of returning a response shaped like a successful one.
 */
function fromOllamaEmbedResponse(
  responseData: Record<string, unknown>,
  requestedModel: string,
): Record<string, unknown> | null {
  const embeddings = responseData.embeddings;
  if (!Array.isArray(embeddings) || !embeddings.every((embedding) => Array.isArray(embedding))) {
    return null;
  }

  const promptTokens = typeof responseData.prompt_eval_count === 'number' ? responseData.prompt_eval_count : 0;
  return {
    object: 'list',
    data: embeddings.map((embedding, index) => ({ object: 'embedding', embedding, index })),
    model: typeof responseData.model === 'string' ? responseData.model : requestedModel,
    usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
  };
}

/**
 * Handle embeddings API request
 */
export async function handleEmbeddingsRequest(
  request: Request,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  logger: Logger,
  _env: Env,
  upstreamMode?: string,
): Promise<Response> {
  logger.info(requestId, `Embeddings request -> ${targetUrl}`);

  // Parse request body
  const bodyText = await request.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return createErrorResponse(new Error('Invalid JSON body'), requestId, 400);
  }

  // Validate required fields
  if (!body.model || typeof body.model !== 'string') {
    return createErrorResponse(new Error('Missing required field: model'), requestId, 400);
  }
  if (body.input === undefined || body.input === null) {
    return createErrorResponse(new Error('Missing required field: input'), requestId, 400);
  }

  const isOllamaEmbed = upstreamMode === 'ollama-embed';

  // POST /api/embed always returns float arrays, so a base64 request cannot be
  // honoured. Handing back floats to a caller that asked for base64 would be a
  // silent correctness bug, so reject it explicitly.
  if (isOllamaEmbed && body.encoding_format === 'base64') {
    return createErrorResponse(
      new Error('encoding_format "base64" is not supported by the "ollama-embed" upstream: Ollama\'s POST /api/embed returns float arrays only'),
      requestId,
      400,
    );
  }

  const upstreamBody = isOllamaEmbed ? toOllamaEmbedRequest(body) : body;

  // Make upstream request
  const upstreamResponse = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...addForwardedHeaders(authHeaders, request),
    },
    body: JSON.stringify(upstreamBody),
    signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(_env as Record<string, unknown>)),
  });

  if (!upstreamResponse.ok) {
    logger.error(requestId, `Upstream embedding error: ${upstreamResponse.status}`);
    // Forward upstream error as-is
    const errorText = await upstreamResponse.text();
    return new Response(errorText, {
      status: upstreamResponse.status,
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': requestId,
      },
    });
  }

  const responseText = await upstreamResponse.text();
  let responseData: Record<string, unknown>;
  try {
    responseData = JSON.parse(responseText);
  } catch {
    return createErrorResponse(new Error('Invalid upstream response'), requestId, 502);
  }

  if (isOllamaEmbed) {
    const converted = fromOllamaEmbedResponse(responseData, body.model);
    if (!converted) {
      return createErrorResponse(
        new Error('Invalid upstream response: POST /api/embed returned no usable "embeddings" array'),
        requestId,
        502,
      );
    }
    responseData = converted;
  }

  // Strip provider field if present (as noted in the API spec)
  if (responseData.provider !== undefined) {
    delete responseData.provider;
  }

  return new Response(JSON.stringify(responseData), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': requestId,
    },
  });
}