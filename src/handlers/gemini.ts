/**
 * Gemini API handler for Claude Proxy v3
 *
 * Handles interactions with Gemini Generative Language API
 * Supports both standard Claude API format and Gemini Interactions API
 */

import { Env } from '../types/shared.js';
import { Logger, createLogger, logPipelineStage, logPipelineHeaders } from '../utils/logger.js';
import { ClaudeMessagesRequest, ClaudeMessagesResponse } from '../types/claude.js';
import { GeminiInteractionRequest, GeminiInteractionResponse } from '../types/gemini.js';
import { convertClaudeToGeminiRequest } from '../converters/claude-to-gemini.js';
import { convertGeminiToClaudeResponse } from '../converters/gemini-to-claude.js';
import { convertGeminiGenerateContentToClaude } from '../converters/gemini-to-claude.js';
import { createGeminiStreamTransformer, createNativeGeminiStreamTransformer } from '../converters/gemini-streaming.js';
import { convertOpenAIToClaudeResponse } from '../converters/openai-to-claude.js';
import { createStreamTransformer } from '../converters/streaming.js';
import { handleTargetApiError } from '../utils/errors.js';
import { addForwardedHeaders } from '../utils/routing.js';
import { createUpstreamAbortSignal, getUpstreamBodyTimeoutMs } from '../utils/fetch-timeout.js';
import { recordResponseStatusCodeFromUpstream } from '../utils/dashboard-stats.js';
import { recordUpstreamRateLimit } from '../utils/provider-quota.js';
import { runHook, applyAfterUpstream, type HookContext } from '../utils/request-transform.js';
import type { ModelRouteConfig } from '../utils/config-loader.js';

/**
 * Gemini API configuration
 */
interface GeminiConfig {
    baseUrl: string;
    apiVersion: string;
}

/**
 * Default Gemini API configuration
 */
const DEFAULT_GEMINI_CONFIG: GeminiConfig = {
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiVersion: 'v1beta',
};

/**
 * Get Gemini API configuration from environment
 */
function getGeminiConfig(env: Env): GeminiConfig {
    return {
        baseUrl: DEFAULT_GEMINI_CONFIG.baseUrl,
        apiVersion: DEFAULT_GEMINI_CONFIG.apiVersion,
    };
}

/**
 * Check if request is in native Gemini format
 */
function isNativeGeminiRequest(body: Record<string, unknown>): boolean {
    // Native Gemini requests have 'input' or 'contents' field, Claude requests have 'messages'
    return ('input' in body || 'contents' in body) && !('messages' in body);
}

/**
 * Handle Gemini API request for /v1/messages endpoint (returns Claude format)
 */
export async function handleGeminiRequestForMessages(
    request: Request,
    targetUrl: string,
    authHeaders: Record<string, string>,
    requestId: string,
    modelId?: string,
    env?: Env,
    logger?: Logger,
    route?: ModelRouteConfig,
): Promise<Response> {
    const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);
    activeLogger.debug(requestId, 'Routing to Gemini generateContent handler for /v1/messages (Claude format output)');

    // Always use generateContent handler but return Claude format
    return handleGeminiGenerateContentRequest(
        request, targetUrl, authHeaders, requestId, modelId, env, logger, 'claude-format', route
    );
}

/**
 * Handle Gemini API request (factory function)
 * Routes to either Interactions or generateContent handler based on URL
 */
export async function handleGeminiRequest(
    request: Request,
    targetUrl: string,
    authHeaders: Record<string, string>,
    requestId: string,
    modelId?: string,
    env?: Env,
    logger?: Logger,
    route?: ModelRouteConfig,
): Promise<Response> {
    const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);

    // Determine which handler to use based on original request path
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/v1/interactions' || path.startsWith('/v1/interactions?')) {
        activeLogger.debug(requestId, 'Routing to Gemini Interactions handler');
        return handleGeminiInteractionsRequest(
            request, targetUrl, authHeaders, requestId, modelId, env, logger, route
        );
    } else if (path.includes(':countTokens')) {
        activeLogger.debug(requestId, 'Routing to Gemini countTokens handler');
        return handleGeminiCountTokensRequest(
            request, targetUrl, authHeaders, requestId, modelId, env, logger, route
        );
    } else {
        activeLogger.debug(requestId, 'Routing to Gemini generateContent handler');
        return handleGeminiGenerateContentRequest(
            request, targetUrl, authHeaders, requestId, modelId, env, logger, 'native-gemini', route
        );
    }
}

/**
 * Handle Gemini :countTokens request — proxy the body to the upstream countTokens endpoint
 * and return the raw JSON response (totalTokens).
 */
async function handleGeminiCountTokensRequest(
    request: Request,
    targetUrl: string,
    authHeaders: Record<string, string>,
    requestId: string,
    modelId?: string,
    env?: Env,
    logger?: Logger,
    route?: ModelRouteConfig
): Promise<Response> {
    const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);
    activeLogger.debug(requestId, `Gemini countTokens request to: ${targetUrl}`);

    let geminiHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...authHeaders,
    };
    geminiHeaders = addForwardedHeaders(geminiHeaders, request);
    logPipelineHeaders(activeLogger, requestId, 'upstream-request', targetUrl, geminiHeaders);

    const response = await fetch(targetUrl, {
        method: 'POST',
        headers: geminiHeaders,
        body: request.body,
        signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env)),
    });

    logPipelineHeaders(activeLogger, requestId, 'upstream-response', targetUrl, response.headers);
    recordResponseStatusCodeFromUpstream(response.status);
    recordUpstreamRateLimit(modelId, (name) => response.headers.get(name), targetUrl);

    if (!response.ok) {
        const errorText = await response.text();
        activeLogger.error(requestId, `Gemini countTokens error: ${errorText}`);
        handleTargetApiError(response, 'Gemini API', { url: targetUrl, upstreamBody: errorText });
    }

    const responseText = await response.text();
    const countTokensOutHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
    logPipelineHeaders(activeLogger, requestId, 'outbound', ':countTokens', countTokensOutHeaders);
    return new Response(responseText, { status: 200, headers: countTokensOutHeaders });
}

/**
 * Handle Gemini Interactions API request
 */
async function handleGeminiInteractionsRequest(
    request: Request,
    targetUrl: string,
    authHeaders: Record<string, string>,
    requestId: string,
    modelId?: string,
    env?: Env,
    logger?: Logger,
    route?: ModelRouteConfig,
): Promise<Response> {
    const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);
    const requestBody = await request.json() as Record<string, unknown>;
    logPipelineStage(activeLogger, requestId, 'inbound', '/v1/interactions', requestBody);
    logPipelineHeaders(activeLogger, requestId, 'inbound', '/v1/interactions', request.headers);

    activeLogger.debug(requestId, `Interactions request to: ${targetUrl}`);
    
    // Convert Interactions format to generateContent format
    const geminiRequest: Record<string, unknown> = {
        contents: []
    };
    
    // Handle input field (string, object with messages, Content, array of Content, or array of Turn)
    if (typeof requestBody.input === 'string') {
        geminiRequest.contents = [{ role: 'user', parts: [{ text: requestBody.input }] }];
    } else if (requestBody.input && typeof requestBody.input === 'object' && 'messages' in requestBody.input) {
        // Handle input.messages format (Interactions API standard)
        const input = requestBody.input as Record<string, unknown>;
        if (Array.isArray(input.messages)) {
            geminiRequest.contents = input.messages.map((msg: any) => ({
                role: msg.role === 'assistant' ? 'model' : msg.role,
                parts: typeof msg.content === 'string' 
                    ? [{ text: msg.content }]
                    : Array.isArray(msg.content)
                        ? msg.content.map((c: any) => c.type === 'text' ? { text: c.text } : c)
                        : [{ text: String(msg.content) }]
            }));
        }
    } else if (Array.isArray(requestBody.input)) {
        // Check if it's array of Turn (has role field) or array of Content
        const firstItem = requestBody.input[0] as any;
        if (firstItem && 'role' in firstItem) {
            // Array of Turn format
            geminiRequest.contents = requestBody.input.map((turn: any) => ({
                role: turn.role === 'model' ? 'model' : 'user',
                parts: typeof turn.content === 'string' 
                    ? [{ text: turn.content }]
                    : Array.isArray(turn.content)
                        ? turn.content.map((c: any) => c.type === 'text' ? { text: c.text } : c)
                        : [{ text: String(turn.content) }]
            }));
        } else {
            // Array of Content format
            geminiRequest.contents = [{ 
                role: 'user', 
                parts: requestBody.input.map((c: any) => c.type === 'text' ? { text: c.text } : c)
            }];
        }
    }
    
    // Check for streaming
    const isStreaming = requestBody.stream === true;
    
    // Copy generation config
    if (requestBody.generation_config) {
        geminiRequest.generationConfig = requestBody.generation_config;
    }
    if (requestBody.system_instruction) {
        geminiRequest.systemInstruction = { parts: [{ text: requestBody.system_instruction as string }] };
    }
    if (requestBody.tools) {
        geminiRequest.tools = requestBody.tools;
    }
    if (requestBody.cached_content) {
        geminiRequest.cachedContent = requestBody.cached_content;
    }
    
    // Add stream parameter to gemini request
    if (isStreaming) {
        geminiRequest.stream = true;
    }
    
    activeLogger.debug(requestId, `Converted request: ${JSON.stringify(geminiRequest).substring(0, 200)}...`);
    activeLogger.debug(requestId, `Is streaming: ${isStreaming}`);
    
    // Prepare headers for Gemini API - authHeaders already contains the correct format
    // from the main router (x-goog-api-key for native Gemini mode)
    let geminiHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...authHeaders,  // Already has correct x-goog-api-key from router
    };

    activeLogger.debug(requestId, `Using auth headers: ${Object.keys(geminiHeaders).join(', ')}`);
    geminiHeaders = addForwardedHeaders(geminiHeaders, request);
    const fullTargetUrl = constructGeminiUrl(targetUrl, request, geminiRequest, modelId || requestBody.model as string | undefined);

    let upstreamBodyGemini: Record<string, unknown> = geminiRequest;
    if (route) {
        const hookCtx: HookContext = {
            hook: 'before_upstream',
            route,
            upstreamMode: 'gemini',
            clientModel: (requestBody.model as string) || modelId || 'unknown',
            requestId,
            streaming: isStreaming,
            logger: activeLogger,
        };
        ({ body: upstreamBodyGemini, headers: geminiHeaders } = runHook('before_upstream', { body: upstreamBodyGemini, headers: geminiHeaders }, hookCtx));
    }

    logPipelineStage(activeLogger, requestId, 'upstream-request', fullTargetUrl, upstreamBodyGemini);
    logPipelineHeaders(activeLogger, requestId, 'upstream-request', fullTargetUrl, geminiHeaders);
    let response = await fetch(fullTargetUrl, {
        method: 'POST',
        headers: geminiHeaders,
        body: JSON.stringify(upstreamBodyGemini),
        signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env)),
    });

    if (route) {
        response = await applyAfterUpstream(response, {
            hook: 'after_upstream', route, upstreamMode: 'gemini',
            clientModel: (requestBody.model as string) || modelId || 'unknown',
            requestId, streaming: isStreaming, logger: activeLogger,
        });
    }

    logPipelineHeaders(activeLogger, requestId, 'upstream-response', fullTargetUrl, response.headers);
    activeLogger.debug(requestId, `Response status: ${response.status}`);
    recordResponseStatusCodeFromUpstream(response.status);
    recordUpstreamRateLimit((requestBody.model as string) || modelId, (name) => response.headers.get(name), fullTargetUrl);

    if (!response.ok) {
        const errorText = await response.text();
        activeLogger.error(requestId, `Gemini API error: ${errorText}`);
        const bodyPreview = JSON.stringify(geminiRequest).substring(0, 1000);
        handleTargetApiError(response, 'Gemini API', { url: fullTargetUrl, body: bodyPreview, upstreamBody: errorText });
    }

    // Handle streaming response
    if (isStreaming) {
        return handleGeminiStreamingResponse(response, requestBody.model as string || modelId || 'gemini-no-id-at-proxy', requestId, activeLogger, 'interactions');
    }
    
    // Convert generateContent response to Interactions format
    const geminiResponseText = await response.text();
    logPipelineStage(activeLogger, requestId, 'upstream-response', fullTargetUrl, geminiResponseText);
    const geminiResponse = JSON.parse(geminiResponseText) as any;
    
    const interactionResponse = {
        id: `v1_${Date.now()}_${requestId}`,
        model: requestBody.model || modelId || 'gemini-no-id-at-proxy',
        status: 'completed',
        object: 'interaction',
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        role: 'model',
        outputs: [] as any[],
        usage: {
            total_input_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
            total_output_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0,
            total_tokens: geminiResponse.usageMetadata?.totalTokenCount || 0,
            ...(geminiResponse.usageMetadata?.cachedContentTokenCount ? { total_cached_tokens: geminiResponse.usageMetadata.cachedContentTokenCount } : {}),
        }
    };
    
    // Convert candidates to outputs
    if (geminiResponse.candidates && geminiResponse.candidates.length > 0) {
        const candidate = geminiResponse.candidates[0];
        if (candidate.content && candidate.content.parts) {
            interactionResponse.outputs = candidate.content.parts.map((part: any) => {
                if (part.text) {
                    return { type: 'text', text: part.text };
                }
                return part;
            });
        }
    }

    logPipelineStage(activeLogger, requestId, 'outbound', '/v1/interactions', interactionResponse);
    const interactionsOutHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
    logPipelineHeaders(activeLogger, requestId, 'outbound', '/v1/interactions', interactionsOutHeaders);
    return new Response(JSON.stringify(interactionResponse), { status: 200, headers: interactionsOutHeaders });
}


/**
 * Handle Gemini generateContent API request
 */
async function handleGeminiGenerateContentRequest(
    request: Request,
    targetUrl: string,
    authHeaders: Record<string, string>,
    requestId: string,
    modelId?: string,
    env?: Env,
    logger?: Logger,
    outputFormat: 'native-gemini' | 'claude-format' = 'native-gemini',
    route?: ModelRouteConfig,
): Promise<Response> {
    const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);
    activeLogger.debug(requestId, `[DEBUG] handleGeminiGenerateContentRequest authHeaders: ${JSON.stringify(authHeaders)}`);

    // Parse request body
    let requestBody = await request.json() as Record<string, unknown>;
    logPipelineStage(activeLogger, requestId, 'inbound', outputFormat === 'claude-format' ? '/v1/messages (via generateContent)' : ':generateContent', requestBody);
    logPipelineHeaders(activeLogger, requestId, 'inbound', outputFormat === 'claude-format' ? '/v1/messages (via generateContent)' : ':generateContent', request.headers);

    // before_conversion: client-schema transforms that need route/upstreamMode resolved
    // but must run before the format converter sees the body.
    if (route) {
        const hookCtxConv: HookContext = {
            hook: 'before_conversion',
            route,
            upstreamMode: 'gemini',
            clientModel: (requestBody.model as string) || modelId || 'unknown',
            requestId,
            streaming: requestBody.stream === true,
            logger: activeLogger,
        };
        ({ body: requestBody } = runHook('before_conversion', { body: requestBody, headers: authHeaders }, hookCtxConv));
    }

    // Determine if this is a native Gemini request or needs conversion from Claude format
    let geminiRequest: Record<string, unknown>;
    let isStreaming: boolean;
    let effectiveModelId = modelId;

    if (isNativeGeminiRequest(requestBody)) {
        // Native Gemini format - use directly
        activeLogger.debug(requestId, 'Using native Gemini request format');
        geminiRequest = requestBody;
        isStreaming = requestBody.stream === true;
        effectiveModelId = effectiveModelId || (requestBody.model as string);

        // Convert native format (input: string) to generateContent format (contents: [...])
        if (typeof geminiRequest.input === 'string') {
            geminiRequest = {
                model: effectiveModelId || geminiRequest.model || 'gemini-no-id-at-proxy',
                contents: [{ role: 'user', parts: [{ text: geminiRequest.input }] }],
                stream: isStreaming,
            };
        }
    } else {
        // Claude format - convert to Gemini generateContent format
        activeLogger.debug(requestId, 'Converting Claude request to Gemini format');
        const claudeRequest = requestBody as unknown as ClaudeMessagesRequest;
        geminiRequest = convertClaudeToGeminiRequest(claudeRequest, modelId);
        isStreaming = claudeRequest.stream === true;
        effectiveModelId = effectiveModelId || claudeRequest.model;
    }

    // Determine the target endpoint
    const fullTargetUrl = constructGeminiUrl(targetUrl, request, geminiRequest, effectiveModelId);

    // Check if upstream will return SSE (based on URL)
    const upstreamIsStreaming = fullTargetUrl.includes(":streamGenerateContent");
    if (upstreamIsStreaming) {
        isStreaming = true;
    }

    // Log request info
    activeLogger.debug(requestId, `Full URL: ${fullTargetUrl}`);
    activeLogger.debug(requestId, `Gemini model: ${effectiveModelId || 'gemini-no-id-at-proxy'}`);
    activeLogger.debug(requestId, `Is streaming: ${isStreaming}`);

    // Prepare headers for Gemini API - authHeaders already contains the correct format
    // from the main router (x-goog-api-key for native Gemini mode)
    let geminiHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...authHeaders,
    };

    activeLogger.debug(requestId, `Using auth headers: ${Object.keys(geminiHeaders).join(', ')}`);
    geminiHeaders = addForwardedHeaders(geminiHeaders, request);

    let upstreamBodyGeminiGen: Record<string, unknown> = geminiRequest;
    if (route) {
        const hookCtx: HookContext = {
            hook: 'before_upstream',
            route,
            upstreamMode: 'gemini',
            clientModel: effectiveModelId || modelId || 'unknown',
            requestId,
            streaming: isStreaming,
            logger: activeLogger,
        };
        ({ body: upstreamBodyGeminiGen, headers: geminiHeaders } = runHook('before_upstream', { body: upstreamBodyGeminiGen, headers: geminiHeaders }, hookCtx));
    }

    try {
        logPipelineStage(activeLogger, requestId, 'upstream-request', fullTargetUrl, upstreamBodyGeminiGen);
        logPipelineHeaders(activeLogger, requestId, 'upstream-request', fullTargetUrl, geminiHeaders);
        let response = await fetch(fullTargetUrl, {
            method: 'POST',
            headers: geminiHeaders,
            body: JSON.stringify(upstreamBodyGeminiGen),
            signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env)),
        });

        if (route) {
            response = await applyAfterUpstream(response, {
                hook: 'after_upstream', route, upstreamMode: 'gemini',
                clientModel: effectiveModelId || modelId || 'unknown',
                requestId, streaming: isStreaming, logger: activeLogger,
            });
        }

        logPipelineHeaders(activeLogger, requestId, 'upstream-response', fullTargetUrl, response.headers);
        recordResponseStatusCodeFromUpstream(response.status);
        recordUpstreamRateLimit(effectiveModelId || modelId, (name) => response.headers.get(name), fullTargetUrl);

        // Handle target API errors
        if (!response.ok) {
            const upstreamErrorBody = await response.text();
            const bodyPreview = JSON.stringify(geminiRequest).substring(0, 1000);
            handleTargetApiError(response, 'Gemini API', { url: fullTargetUrl, body: bodyPreview, upstreamBody: upstreamErrorBody });
        }

        // Handle streaming response
        if (isStreaming) {
            const endpointType = outputFormat === 'claude-format' ? 'interactions' : 'native-gemini';
            return handleGeminiStreamingResponse(response, effectiveModelId || 'gemini-no-id-at-proxy', requestId, activeLogger, endpointType);
        }

        // Handle non-streaming response
        const endpointType = outputFormat === 'claude-format' ? 'interactions' : 'native-gemini';
        return handleGeminiNonStreamingResponse(response, effectiveModelId || 'gemini-no-id-at-proxy', requestId, activeLogger, endpointType);

    } catch (error) {
        activeLogger.error(requestId, `Gemini API error: ${(error as Error).message}`);
        throw error;
    }
}

/**
 * Determine the Gemini endpoint based on request
 */
function determineGeminiEndpoint(request: Request, geminiRequest: Record<string, unknown>, modelId?: string): string {
    // Default: generateContent endpoint
    const model = modelId || (geminiRequest.model as string) || 'gemini-no-id-at-proxy';
    return `/v1/models/${model}:generateContent`;
}

/**
 * Construct full Gemini API URL, handling v1beta vs v1 path differences
 */
function constructGeminiUrl(targetUrl: string, request: Request, geminiRequest: Record<string, unknown>, effectiveModelId?: string): string {
    // Extract model from targetUrl if it contains :generateContent
    const urlMatch = targetUrl.match(/\/(v1beta|v1)\/models\/([^:?]+):(stream)?[Gg]enerateContent/);
    if (urlMatch) {
        // URL already contains model and endpoint, reconstruct with the same API version
        const apiVersion = urlMatch[1];
        const urlModel = urlMatch[2];
        const isStream = urlMatch[3] === 'stream';
        const endpoint = isStream ? 'streamGenerateContent' : 'generateContent';
        const queryString = targetUrl.includes('?') ? targetUrl.substring(targetUrl.indexOf('?')) : '';
        const baseOnly = targetUrl.split(`/${apiVersion}/models`)[0];
        return `${baseOnly}/${apiVersion}/models/${urlModel}:${endpoint}${queryString}`;
    } else {
        // Need to add endpoint. /v1/responses and /v1/interactions pass targetUrl as .../v1beta;
        // /v1/messages may pass .../v1beta/models.
        const model = effectiveModelId || (geminiRequest.model as string) || 'gemini-no-id-at-proxy';
        const normalizedTargetUrl = targetUrl.replace(/\/$/, '');
        const endpoint = normalizedTargetUrl.match(/\/(v1beta|v1)$/)
            ? `/models/${model}:generateContent`
            : normalizedTargetUrl.match(/\/(v1beta|v1)\/models$/)
                ? `/${model}:generateContent`
                : determineGeminiEndpoint(request, geminiRequest, effectiveModelId);
        return `${normalizedTargetUrl}${endpoint}`;
    }
}

/**
 * Extract interaction ID from path
 */
function extractInteractionId(path: string): string {
    const parts = path.split('/');
    const interactionIndex = parts.findIndex(p => p === 'interactions');
    if (interactionIndex >= 0 && parts[interactionIndex + 1]) {
        return parts[interactionIndex + 1];
    }
    throw new Error('Invalid interaction path');
}

/**
 * Handle non-streaming response
 */
async function handleGeminiNonStreamingResponse(
    response: Response,
    model: string,
    requestId: string,
    logger: Logger,
    endpointType: 'interactions' | 'openai-compatible' | 'native-gemini' = 'interactions'
): Promise<Response> {
    try {
        // Upstream-response headers are logged by callers; only body is logged here.
        const responseText = await response.text();
        logger.debug(requestId, 'Gemini response received');
        logPipelineStage(logger, requestId, 'upstream-response', response.url || '(upstream)', responseText);

        if (endpointType === 'native-gemini') {
            // Native Gemini format - return as-is
            logPipelineStage(logger, requestId, 'outbound', ':generateContent (native)', responseText);
            const nativeOutHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
            logPipelineHeaders(logger, requestId, 'outbound', ':generateContent (native)', nativeOutHeaders);
            return new Response(responseText, { status: response.status, headers: nativeOutHeaders });
        } else if (endpointType === 'openai-compatible') {
            // Parse OpenAI-compatible response
            const openaiResponse = JSON.parse(responseText);
            const claudeResponse = convertOpenAIToClaudeResponse(
                openaiResponse,
                model,
                requestId
            );
            logPipelineStage(logger, requestId, 'outbound', '/v1/messages', claudeResponse);
            const openaiCompatOutHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
            logPipelineHeaders(logger, requestId, 'outbound', '/v1/messages', openaiCompatOutHeaders);
            return new Response(JSON.stringify(claudeResponse), { status: 200, headers: openaiCompatOutHeaders });
        } else {
            // Parse native Gemini generateContent response
            const geminiResponse = JSON.parse(responseText);

            // Convert to Claude format
            const claudeResponse = convertGeminiGenerateContentToClaude(geminiResponse, model, requestId);
            logPipelineStage(logger, requestId, 'outbound', '/v1/messages (via generateContent)', claudeResponse);

            const genContentOutHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
            logPipelineHeaders(logger, requestId, 'outbound', '/v1/messages (via generateContent)', genContentOutHeaders);
            return new Response(JSON.stringify(claudeResponse), { status: 200, headers: genContentOutHeaders });
        }
    } catch (error) {
        logger.error(requestId, `Error converting Gemini response: ${(error as Error).message}`);
        throw new Error(`Failed to convert Gemini response: ${(error as Error).message}`);
    }
}

/**
 * Handle streaming response
 */
async function handleGeminiStreamingResponse(
    response: Response,
    model: string,
    requestId: string,
    logger: Logger,
    endpointType: 'interactions' | 'openai-compatible' | 'native-gemini' = 'interactions'
): Promise<Response> {
    if (!response.body) {
        throw new Error('Response body is not readable');
    }

    const decoder = new TextDecoder();

    try {
        logger.debug(requestId, 'Gemini streaming response started');

        // Create streaming transformer based on endpoint type
        const transformer = endpointType === 'native-gemini'
            ? createNativeGeminiStreamTransformer(model, requestId)
            : endpointType === 'openai-compatible'
            ? createStreamTransformer(model, requestId)
            : createGeminiStreamTransformer(model, requestId);

        // Create a tee to read the raw response while also transforming it
        const [stream1, stream2] = response.body.tee();

        // Read and log raw chunks from stream2
        const reader = stream2.getReader();
        const logRawChunks = async () => {
            try {
                let rawData = '';
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    rawData += decoder.decode(value, { stream: true });
                    const lines = rawData.split('\n');
                    if (lines.length > 1) {
                        for (const line of lines.slice(0, -1)) {
                            if (line.startsWith('data: ')) {
                                const data = line.substring(6);
                                if (data.trim() !== '[DONE]') {
                                    logPipelineStage(logger, requestId, 'upstream-response', response.url || '(upstream SSE)', data);
                                }
                            }
                        }
                        rawData = lines[lines.length - 1] || '';
                    }
                }
            } catch (e) {
                logger.error(requestId, `Error logging raw chunks: ${(e as Error).message}`);
            }
        };

        // Start logging in background
        logRawChunks();

        // Create transformed stream from stream1; tee again so the outbound
        // events sent to the client are also logged at trace level.
        const transformerObj = transformer as any;
        const [outStream1, outStream2] = stream1
            .pipeThrough(new TransformStream(transformerObj))
            .tee();
        (async () => {
            try {
                const outReader = outStream2.getReader();
                const outDecoder = new TextDecoder();
                let outBuffer = '';
                while (true) {
                    const { done, value } = await outReader.read();
                    if (done) break;
                    outBuffer += outDecoder.decode(value, { stream: true });
                    const lines = outBuffer.split('\n');
                    if (lines.length > 1) {
                        for (const line of lines.slice(0, -1)) {
                            if (line.startsWith('data: ')) {
                                const data = line.substring(6);
                                if (data.trim() !== '[DONE]') {
                                    logPipelineStage(logger, requestId, 'outbound', 'stream', data);
                                }
                            }
                        }
                        outBuffer = lines[lines.length - 1] || '';
                    }
                }
            } catch {
                // best-effort debug logging only
            }
        })();
        const transformedStream = outStream1;

        const streamOutHeaders = {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'x-request-id': requestId,
        };
        logPipelineHeaders(logger, requestId, 'outbound', 'stream', streamOutHeaders);
        return new Response(transformedStream, { status: 200, headers: streamOutHeaders });
    } catch (error) {
        logger.error(requestId, `Error creating streaming response: ${(error as Error).message}`);
        throw new Error(`Failed to create streaming response: ${(error as Error).message}`);
    }
}

/**
 * Check if a request is for Gemini API
 */
export function isGeminiRequest(request: Request, targetUrl: string): boolean {
    const url = new URL(request.url);
    const path = url.pathname;

    // Check if path indicates Gemini API
    if (path.includes('/v1/interactions') ||
        path.includes('/v1beta/interactions') ||
        targetUrl.includes('generativelanguage.googleapis.com')) {
        return true;
    }

    // Check for Gemini model identifiers in request
    if (targetUrl.includes('gemini')) {
        return true;
    }

    return false;
}
