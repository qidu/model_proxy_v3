/**
 * Claude API Types (v3 with extended thinking support)
 * Based on Claude API documentation
 */

// --- Content Types ---

export interface ClaudeTool {
    name: string;
    description?: string;
    input_schema: any;
}

export type ThinkingConfigParam = {
    type: "enabled" | "adaptive" | true;
    budget_tokens?: number;
} | {
    type: "disabled" | false;
};

export type ClaudeContent =
    | string  // Simple string (shorthand for text block)
    | Array<ClaudeContentBlock>;

export interface ThinkingBlock {
    type: "thinking";
    thinking: string;
    signature?: string;
}

export interface WebSearchToolResultBlock {
    type: "web_search_result";
    search_query: string;
    search_results: Array<{
        title: string;
        url: string;
        snippet: string;
    }>;
}

export type ClaudeContentBlock =
    | ClaudeTextBlock
    | ClaudeImageBlock
    | ClaudeDocumentBlock
    | ClaudeToolUseBlock
    | ClaudeToolResultBlock
    | WebSearchToolResultBlock
    | ThinkingBlock;

export interface Citation {
    type: "char_location";
    cited_text: string;
    document_index: number;
    document_title: string;
    start_char_index: number;
    end_char_index: number;
}

export interface ClaudeTextBlock {
    type: "text";
    text: string;
    citations?: Citation[];
    cache_control?: {
        type: "ephemeral";
        ttl: "5m" | "1h";
    };
}

export interface ClaudeImageBlock {
    type: "image";
    source: {
        type: "base64" | "url";
        media_type?: string;  // Required for base64, optional for URL
        data?: string;        // Required for base64
        url?: string;         // Required for URL
    };
}

export interface ClaudeDocumentBlock {
    type: "document";
    source: {
        type: "base64" | "text";
        media_type: string;
        data: string;
    };
    title?: string;
}

export interface ClaudeToolUseBlock {
    type: "tool_use";
    id: string;
    name: string;
    input: any;
}

export interface ClaudeToolResultBlock {
    type: "tool_result";
    tool_use_id: string;
    content: string | ClaudeContentBlock[];
}

// --- Message Types ---

export interface ClaudeMessage {
    role: "user" | "assistant";
    content: ClaudeContent;
}

// --- Request Types ---

export interface ClaudeMessagesRequest {
    model: string;
    messages: ClaudeMessage[];
    system?: string | ClaudeTextBlock[];
    max_tokens: number;
    stop_sequences?: string[];
    stream?: boolean;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    tools?: ClaudeTool[];
    tool_choice?: { type: "auto" | "any" | "tool"; name?: string } | { type: "none" };
    thinking?: ThinkingConfigParam;
    reasoning_effort?: "low" | "medium" | "high" | "max";
    output_config?: {
        effort?: "low" | "medium" | "high" | "max";
        task_budget?: {
            type: "tokens";
            total: number;
        };
    };
    service_tier?: "auto" | "standard_only";
    metadata?: {
        user_id?: string;
    };
    cached_content?: string;
}

export interface ClaudeTokenCountingRequest {
    model: string;
    messages: ClaudeMessage[];
    system?: string | ClaudeTextBlock[];
    tools?: ClaudeTool[];
    tool_choice?: { type: "auto" | "any" | "tool"; name?: string } | { type: "none" };
    thinking?: ThinkingConfigParam;
}

// --- Response Types ---

export interface ClaudeMessagesResponse {
    id: string;
    type: "message";
    role: "assistant";
    content: ClaudeContentBlock[];
    model: string;
    stop_reason: string | null;
    stop_sequence?: string;
    usage: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
    };
}

export interface ClaudeTokenCountingResponse {
    type: "token_count";
    input_tokens: number;
}

export interface ClaudeModelsResponse {
    data: ClaudeModel[];
    first_id: string | null;
    has_more: boolean;
    last_id: string | null;
}

export interface ClaudeModel {
    id: string;
    type: "model";
    created_at: string;  // RFC 3339 timestamp
    display_name: string;
    context_length?: number;
    max_tokens?: number;
}

// --- Streaming Types ---

export interface ClaudeStreamEvent {
    type: "message_start" | "content_block_start" | "content_block_delta" | 
          "content_block_stop" | "message_delta" | "message_stop" | "thinking_delta";
    message?: {
        id: string;
        type: string;
        role: string;
        model: string;
        thinking?: { type: "text"; text: string };
    };
    content_block?: {
        type: "text" | "tool_use";
        text?: string;
        name?: string;
        index: number;
    };
    delta?: {
        type: "text_delta" | "input_json_delta" | "thinking_delta" | "signature_delta";
        text?: string;
        partial_json?: string;
        signature?: string;
        index: number;
    };
    usage?: {
        input_tokens: number;
        output_tokens: number;
    };
    stop_reason?: string | null;
    stop_sequence?: string;
    index?: number;
}
