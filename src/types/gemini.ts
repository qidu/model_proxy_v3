/**
 * Gemini API Types
 * Based on Google Generative Language API documentation
 */

// --- Content Types ---

export type GeminiContent =
    | GeminiTextContent
    | GeminiImageContent
    | GeminiAudioContent
    | GeminiVideoContent
    | GeminiDocumentContent
    | GeminiFunctionCallContent
    | GeminiFunctionResultContent
    | GeminiThoughtContent
    | GeminiCodeExecutionCallContent
    | GeminiCodeExecutionResultContent;

export interface GeminiTextContent {
    type: 'text';
    text: string;
    annotations?: Array<{
        start_index: number;
        end_index: number;
        source: string;
    }>;
}

export interface GeminiImageContent {
    type: 'image';
    data: string; // Base64 encoded
    uri?: string;
    mime_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/heic' | 'image/heif';
    resolution?: 'low' | 'medium' | 'high' | 'ultra_high';
}

export interface GeminiAudioContent {
    type: 'audio';
    data: string;
    uri?: string;
    mime_type: 'audio/wav' | 'audio/mp3' | 'audio/aiff' | 'audio/aac' | 'audio/ogg' | 'audio/flac';
}

export interface GeminiVideoContent {
    type: 'video';
    data: string;
    uri?: string;
    mime_type: 'video/mp4' | 'video/mpeg' | 'video/mov' | 'video/avi' | 'video/x-flv' | 'video/mpg' | 'video/webm' | 'video/wmv' | 'video/3gpp';
    resolution?: 'low' | 'medium' | 'high' | 'ultra_high';
}

export interface GeminiDocumentContent {
    type: 'document';
    data: string;
    uri?: string;
    mime_type: 'application/pdf';
}

// --- Tool Types ---

export interface GeminiFunctionCallContent {
    type: 'function_call';
    name: string;
    arguments: Record<string, unknown>;
    id: string;
}

export interface GeminiFunctionResultContent {
    type: 'function_result';
    name: string;
    result: string | Record<string, unknown>;
    is_error?: boolean;
    call_id: string;
}

// --- Thought/Reasoning Types ---

export interface GeminiThoughtContent {
    type: 'thought';
    signature: string;
    summary?: {
        content: GeminiTextContent | GeminiImageContent;
    };
}

// --- Code Execution Types ---

export interface GeminiCodeExecutionCallContent {
    type: 'code_execution_call';
    id?: string;
    arguments: {
        code: string;
        language: 'python';
    };
}

export interface GeminiCodeExecutionResultContent {
    type: 'code_execution_result';
    id?: string;
    call_id?: string;
    result: string;
    is_error?: boolean;
    signature?: string;
}

// --- Input/Output Types ---

export type GeminiInput = string | GeminiContent | Array<GeminiContent> | Array<GeminiTurn>;

export interface GeminiTurn {
    role: 'user' | 'model';
    content: GeminiContent | string | Array<GeminiContent>;
}

// --- Tool Definition Types ---

export type GeminiToolType = 'function' | 'google_search' | 'code_execution' | 'url_context' | 'computer_use' | 'mcp_server' | 'file_search';

export interface GeminiTool {
    type: GeminiToolType;
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
    // Google Search
    queries?: string[];
    // Code Execution
    language?: 'python';
    // Computer Use
    environment?: 'browser';
    excludedPredefinedFunctions?: string[];
    // MCP Server
    url?: string;
    headers?: Record<string, string>;
    allowed_tools?: Array<{
        name: string;
        mode?: 'auto' | 'any' | 'none' | 'validated';
        tools?: string[];
    }>;
    // File Search
    file_search_store_names?: string[];
    top_k?: number;
    metadata_filter?: string;
}

// --- Generation Config Types ---

export interface GeminiGenerationConfig {
    temperature?: number;
    top_p?: number;
    seed?: number;
    stop_sequences?: string[];
    // Either the bare enum or the ToolChoiceConfig object form. `function` and
    // `dynamic` are not in the documented enum, but bodies carrying them reach
    // this proxy and are accepted (see geminiToolChoiceToOpenAI in
    // src/converters/gemini-to-openai.ts).
    tool_choice?: 'auto' | 'any' | 'none' | 'validated' | 'dynamic' | 'function' | {
        type?: 'auto' | 'any' | 'none' | 'validated' | 'dynamic' | 'function';
        mode?: 'auto' | 'any' | 'none' | 'validated';
        function?: { name: string };
        tools?: string[];
    };
    thinking_level?: 'minimal' | 'low' | 'medium' | 'high';
    thinking_summaries?: 'auto' | 'none';
    max_output_tokens?: number;
    speech_config?: {
        voice?: string;
        language?: string;
        speaker?: string;
    };
    image_config?: {
        aspect_ratio?: '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4' | '9:16' | '16:9' | '21:9';
        image_size?: '1K' | '2K' | '4K';
    };
    response_format?: Record<string, unknown>;
    response_mime_type?: string;
}

// --- Agent Config Types ---

export interface GeminiAgentConfig {
    type: 'dynamic' | 'deep-research';
    thinking_summaries?: 'auto' | 'none';
}

// --- Usage Stats Types ---

export interface GeminiUsage {
    total_input_tokens: number;
    total_output_tokens: number;
    total_cached_tokens: number;
    total_thought_tokens: number;
    total_tool_use_tokens: number;
    total_tokens: number;
    input_tokens_by_modality?: Array<{
        modality: 'text' | 'image' | 'audio';
        tokens: number;
    }>;
    cached_tokens_by_modality?: Array<{
        modality: 'text' | 'image' | 'audio';
        tokens: number;
    }>;
    output_tokens_by_modality?: Array<{
        modality: 'text' | 'image' | 'audio';
        tokens: number;
    }>;
    tool_use_tokens_by_modality?: Array<{
        modality: 'text' | 'image' | 'audio';
        tokens: number;
    }>;
}

// --- Request Types ---

export interface GeminiInteractionRequest {
    model?: string;
    agent?: string;
    input: GeminiInput;
    system_instruction?: string;
    tools?: GeminiTool[];
    response_format?: Record<string, unknown>;
    response_mime_type?: string;
    stream?: boolean;
    store?: boolean;
    background?: boolean;
    generation_config?: GeminiGenerationConfig;
    agent_config?: GeminiAgentConfig;
    previous_interaction_id?: string;
    response_modalities?: Array<'text' | 'image' | 'audio'>;
    cached_content?: string;
}

// --- Response Types ---

export type GeminiInteractionStatus = 'in_progress' | 'requires_action' | 'completed' | 'failed' | 'cancelled';

export interface GeminiInteractionResponse {
    id: string;
    model?: string;
    agent?: string;
    status: GeminiInteractionStatus;
    object: 'interaction';
    created: string;
    updated: string;
    role: 'model';
    outputs?: GeminiContent[];
    system_instruction?: string;
    tools?: GeminiTool[];
    usage?: GeminiUsage;
    response_modalities?: Array<'text' | 'image' | 'audio'>;
    previous_interaction_id?: string;
    input?: GeminiInput;
    generation_config?: GeminiGenerationConfig;
    agent_config?: GeminiAgentConfig;
}

// --- Streaming Event Types ---

export interface GeminiSSEEvent {
    event_type: 'interaction.created' | 'interaction.completed' | 'interaction.status_update' | 'step.start' | 'step.delta' | 'step.stop' | 'error';
    event_id?: string;
    interaction?: GeminiInteractionResponse;
    interaction_id?: string;
    status?: GeminiInteractionStatus;
    index?: number;
    step?: {
        type: string;
        content?: GeminiContent[];
    };
    delta?: {
        type: string;
        text?: string;
        annotations?: Array<{
            start_index: number;
            end_index: number;
            source: string;
        }>;
        data?: string;
        uri?: string;
        mime_type?: string;
        resolution?: string;
        name?: string;
        arguments?: Record<string, unknown>;
        result?: string | Record<string, unknown>;
        is_error?: boolean;
        call_id?: string;
        id?: string;
        signature?: string;
    };
    error?: {
        code: string;
        message: string;
    };
}

// --- Model Options ---

export type GeminiModelOption =
    | 'gemini-2.5-pro'
    | 'gemini-2.5-flash'
    | 'gemini-2.5-flash-preview-09-2025'
    | 'gemini-2.5-flash-lite'
    | 'gemini-2.5-flash-lite-preview-09-2025'
    | 'gemini-2.5-flash-preview-native-audio-dialog'
    | 'gemini-2.5-flash-image-preview'
    | 'gemini-2.5-pro-preview-tts'
    | 'gemini-3-pro-preview'
    | 'gemini-3-flash-preview';

export type GeminiAgentOption = 'deep-research-pro-preview-12-2025';