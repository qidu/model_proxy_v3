/**
 * Claude API Types (v3 with extended thinking support)
 * Based on Claude API documentation
 */

// --- Content Types ---

export interface ClaudeTool {
    name: string;
    description?: string;
    input_schema: any;
    /**
     * "When true, guarantees schema validation on tool names and inputs"
     * (`messages-create.md:2819`). Declared here because the direct
     * Claude → Responses converter carries it; the Completions bridge dropped it.
     */
    strict?: boolean;
}

/**
 * A Claude `redacted_thinking` block: encrypted reasoning the API returns instead
 * of plaintext when its safety system redacts it. The payload is not readable by
 * anyone but the issuing provider, so no other wire format's field can hold it.
 */
export interface ClaudeRedactedThinkingBlock {
    type: "redacted_thinking";
    data: string;
}

/**
 * One server-side MCP connector, as the Messages API declares it under the
 * `mcp-client-2025-04-04` / `mcp-client-2025-11-20` betas
 * (`claude_api_docs/models-api.md:40`). The Responses API's `mcp` tool declares a
 * faithful equivalent, which is why the direct Claude → Responses converter can
 * carry this where the Completions bridge cannot.
 */
export interface ClaudeMcpServer {
    type: "url";
    url: string;
    name: string;
    authorization_token?: string;
    tool_configuration?: {
        enabled?: boolean;
        allowed_tools?: string[];
    };
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
    | ThinkingBlock
    | ClaudeRedactedThinkingBlock;

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

/**
 * A `document` block's source, in the four forms the API declares
 * (`messages-create.md:250`): a base64 PDF, plain text, a URL to a PDF, or a
 * document composed from other content blocks. Anything else is not a shape this
 * type should let through.
 */
export type ClaudeDocumentSource =
    | { type: "base64"; media_type: "application/pdf"; data: string }
    | { type: "text"; media_type: "text/plain"; data: string }
    | { type: "url"; url: string }
    | { type: "content"; content: string | ClaudeContentBlock[] };

export interface ClaudeDocumentBlock {
    type: "document";
    source: ClaudeDocumentSource;
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
    /**
     * Server-side MCP connectors (beta). Only the direct Claude → Responses
     * converter reads these; `ensureStructuredOutputsBetaHeader` handles the
     * header pairing, and the Completions bridge has no field to carry them.
     */
    mcp_servers?: ClaudeMcpServer[];
    tool_choice?: { type: "auto" | "any" | "tool"; name?: string; disable_parallel_tool_use?: boolean } | { type: "none" };
    thinking?: ThinkingConfigParam;
    reasoning_effort?: "low" | "medium" | "high" | "max";
    output_config?: {
        effort?: "low" | "medium" | "high" | "max";
        /**
         * Structured outputs. `ensureStructuredOutputsBetaHeader` reads this field
         * out of the *body* (`utils/auth-headers.ts:80`), so the converter that
         * builds the body is what has to keep it.
         */
        format?: {
            type: "json_schema";
            schema: Record<string, unknown>;
        };
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
    /**
     * Request-level cache breakpoint: "automatically applies a cache_control
     * marker to the last cacheable block in the request"
     * (`documentation: messages-create.md:2372`).
     */
    cache_control?: {
        type: "ephemeral";
        ttl?: "5m" | "1h";
    };
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
    stop_sequence?: string | null;
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
