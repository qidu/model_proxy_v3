/**
 * OpenAI API Types
 * Based on OpenAI API documentation
 */

// --- Content Types ---

export type OpenAIContent =
    | string
    | Array<OpenAIContentPart>;

export type OpenAIContentPart =
    | OpenAITextPart
    | OpenAIThinkingPart
    | OpenAIImagePart;

export interface OpenAITextPart {
    type: "text";
    text: string;
}

export interface OpenAIThinkingPart {
    type: "thinking";
    thinking: string;
    signature?: string;
}

export interface OpenAIImagePart {
    type: "image_url";
    image_url: {
        url: string;
        detail?: "low" | "high" | "auto";
    };
}

export interface OpenAIToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}

// --- Message Types ---

export type OpenAIRole = "system" | "user" | "assistant" | "tool" | "developer";

export interface OpenAIMessage {
    role: OpenAIRole;
    content: OpenAIContent;
    name?: string;
    tool_calls?: OpenAIToolCall[];
    tool_call_id?: string;
}

// --- Request Types ---

export interface OpenAIRequest {
    model: string;
    messages: OpenAIMessage[];
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    stop?: string | string[];
    stream?: boolean;
    stream_options?: { include_usage?: boolean };
    response_format?: { type: "text" | "json_object" };
    tools?: Array<{
        type: "function";
        function: {
            name: string;
            description?: string;
            parameters: any;
        };
    }>;
    tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
    frequency_penalty?: number;
    presence_penalty?: number;
    logit_bias?: Record<number, number>;
    seed?: number;
    logprobs?: boolean | number;
    top_logprobs?: number;
    thinking?: {
        enabled?: boolean;
        budget_tokens?: number;
    };
    reasoning_effort?: "low" | "medium" | "high" | "max";
    prompt_cache_key?: string;
}

export interface OpenAITokenCountingRequest {
    model: string;
    messages: OpenAIMessage[];
    max_tokens?: number;
    tools?: Array<{
        type: "function";
        function: {
            name: string;
            description?: string;
            parameters: any;
        };
    }>;
    thinking?: {
        enabled?: boolean;
        budget_tokens?: number;
    };
    reasoning_effort?: "low" | "medium" | "high" | "max";
}

// --- Response Types ---

export interface OpenAIResponse {
    id: string;
    object: "chat.completion";
    created: number;
    model: string;
    choices: Array<{
        index: number;
        message: OpenAIMessage;
        finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
        logprobs?: any;
    }>;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
    };
    system_fingerprint?: string;
}

export interface OpenAITokenCountingResponse {
    id: string;
    object: "chat.completion.token_count";
    model: string;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
}

export interface OpenAIModelsResponse {
    object: "list";
    data: OpenAIModel[];
}

export interface OpenAIModel {
    id: string;
    object: "model";
    created: number;
    owned_by: string;
    context_length?: number;
    max_tokens?: number;
}

// --- Streaming Types ---

export interface OpenAIStreamChunk {
    id: string;
    object: "chat.completion.chunk";
    created: number;
    model: string;
    system_fingerprint?: string;
    choices: Array<{
        index: number;
        delta: {
            role?: OpenAIRole;
            content?: string;
            thinking?: string;
            signature?: string;
            tool_calls?: Array<{
                index: number;
                id?: string;
                type?: "function";
                function?: {
                    name?: string;
                    arguments?: string;
                };
            }>;
        };
        finish_reason: string | null;
        logprobs?: any;
    }>;
}
