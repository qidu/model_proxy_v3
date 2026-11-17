/** Gemini Interactions API types based on docs/api/interactions_new.md. */

export type GeminiResponseModality = 'text' | 'image' | 'audio' | 'video' | 'document';
export type GeminiMediaResolution = 'low' | 'medium' | 'high' | 'ultra_high';

export interface GeminiUrlCitation {
    type: 'url_citation';
    url?: string;
    title?: string;
    start_index?: number;
    end_index?: number;
}

export interface GeminiFileCitation {
    type: 'file_citation';
    document_uri?: string;
    file_name?: string;
    source?: string;
    custom_metadata?: Record<string, unknown>;
    page_number?: number;
    media_id?: string;
    start_index?: number;
    end_index?: number;
}

export interface GeminiPlaceCitation {
    type: 'place_citation';
    place_id?: string;
    name?: string;
    url?: string;
    review_snippets?: Array<Record<string, unknown>>;
    start_index?: number;
    end_index?: number;
}

export type GeminiAnnotation = GeminiUrlCitation | GeminiFileCitation | GeminiPlaceCitation;

export interface GeminiTextContent {
    type: 'text';
    text: string;
    annotations?: GeminiAnnotation[];
}

export interface GeminiImageContent {
    type: 'image';
    data?: string;
    uri?: string;
    mime_type?: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/heic' | 'image/heif' | 'image/gif' | 'image/bmp' | 'image/tiff';
    resolution?: GeminiMediaResolution;
}

export interface GeminiAudioContent {
    type: 'audio';
    data?: string;
    uri?: string;
    mime_type?: 'audio/wav' | 'audio/mp3' | 'audio/aiff' | 'audio/aac' | 'audio/ogg' | 'audio/flac' | 'audio/mpeg' | 'audio/m4a' | 'audio/l16' | 'audio/opus' | 'audio/alaw' | 'audio/mulaw';
    channels?: number;
    sample_rate?: number;
}

export interface GeminiVideoContent {
    type: 'video';
    data?: string;
    uri?: string;
    mime_type?: 'video/mp4' | 'video/mpeg' | 'video/mov' | 'video/avi' | 'video/x-flv' | 'video/mpg' | 'video/webm' | 'video/wmv' | 'video/3gpp';
    resolution?: GeminiMediaResolution;
}

export interface GeminiDocumentContent {
    type: 'document';
    data?: string;
    uri?: string;
    mime_type?: 'application/pdf';
}

export interface GeminiFunctionCallContent {
    type: 'function_call';
    name: string;
    arguments: Record<string, unknown>;
    id: string;
    signature?: string;
}

export interface GeminiFunctionResultContent {
    type: 'function_result';
    name?: string;
    result: string | Record<string, unknown> | Array<Record<string, unknown>>;
    is_error?: boolean;
    call_id: string;
    signature?: string;
}

export interface GeminiThoughtContent {
    type: 'thought';
    signature?: string;
    summary?: GeminiTextContent[];
}

export interface GeminiCodeExecutionCallContent {
    type: 'code_execution_call';
    id: string;
    arguments: { code: string; language?: 'python' };
    signature?: string;
}

export interface GeminiCodeExecutionResultContent {
    type: 'code_execution_result';
    call_id: string;
    result: string;
    is_error?: boolean;
    signature?: string;
}

/** Content plus tool payloads retained for converter compatibility. */
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

export interface GeminiStep {
    type: 'user_input' | 'model_output' | 'thought' | 'function_call' | 'function_result'
        | 'code_execution_call' | 'code_execution_result' | 'url_context_call' | 'url_context_result'
        | 'mcp_server_tool_call' | 'mcp_server_tool_result' | 'google_search_call' | 'google_search_result'
        | 'file_search_call' | 'file_search_result' | 'google_maps_call' | 'google_maps_result';
    content?: GeminiContent[];
    summary?: GeminiTextContent[];
    id?: string;
    call_id?: string;
    name?: string;
    server_name?: string;
    arguments?: Record<string, unknown>;
    result?: unknown;
    is_error?: boolean;
    signature?: string;
}

export type GeminiInput = string | GeminiContent | GeminiStep | Array<GeminiContent | GeminiStep | GeminiTurn>;

/** Legacy multi-turn spelling still accepted by the converters. */
export interface GeminiTurn {
    role: 'user' | 'model';
    content: GeminiContent | string | Array<GeminiContent>;
}

export type GeminiToolType = 'function' | 'google_search' | 'code_execution' | 'url_context'
    | 'computer_use' | 'mcp_server' | 'google_maps' | 'retrieval' | 'file_search';

export interface GeminiTool {
    type: GeminiToolType;
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
    search_types?: Array<'web_search' | 'image_search' | 'enterprise_web_search'>;
    environment?: 'browser';
    excluded_predefined_functions?: string[];
    url?: string;
    headers?: Record<string, string>;
    allowed_tools?: {
        mode?: 'auto' | 'any' | 'none' | 'validated';
        tools?: string[];
    };
    enable_widget?: boolean;
    latitude?: number;
    longitude?: number;
    retrieval_types?: Array<'vertex_ai_search'>;
    vertex_ai_search_config?: {
        engine?: string;
        datastores?: string[];
    };
    // Legacy generateContent file-search extension.
    file_search_store_names?: string[];
    top_k?: number;
    metadata_filter?: string;
}

export interface GeminiGenerationConfig {
    temperature?: number;
    top_p?: number;
    seed?: number;
    stop_sequences?: string[];
    tool_choice?: 'auto' | 'any' | 'none' | 'validated' | 'dynamic' | 'function' | {
        type?: 'auto' | 'any' | 'none' | 'validated' | 'dynamic' | 'function';
        mode?: 'auto' | 'any' | 'none' | 'validated';
        function?: { name: string };
        tools?: string[];
        allowed_tools?: { mode?: 'auto' | 'any' | 'none' | 'validated'; tools?: string[] };
    };
    thinking_level?: 'minimal' | 'low' | 'medium' | 'high';
    thinking_summaries?: 'auto' | 'none';
    max_output_tokens?: number;
    speech_config?: { voice?: string; language?: string; speaker?: string };
    image_config?: {
        aspect_ratio?: '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4' | '9:16' | '16:9' | '21:9' | '1:8' | '8:1' | '1:4' | '4:1';
        image_size?: '1K' | '2K' | '4K' | '512';
    };
    response_format?: Record<string, unknown> | Array<Record<string, unknown>>;
    response_mime_type?: string;
}

export interface GeminiAgentConfig {
    type: 'dynamic';
}

export interface GeminiModalityTokens {
    modality?: GeminiResponseModality;
    tokens?: number;
}

export interface GeminiUsage {
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_cached_tokens?: number;
    total_thought_tokens?: number;
    total_tool_use_tokens?: number;
    total_tokens?: number;
    input_tokens_by_modality?: GeminiModalityTokens[];
    cached_tokens_by_modality?: GeminiModalityTokens[];
    output_tokens_by_modality?: GeminiModalityTokens[];
    tool_use_tokens_by_modality?: GeminiModalityTokens[];
    grounding_tool_count?: Array<{
        type?: 'google_search' | 'google_maps' | 'retrieval';
        count?: number;
    }>;
}

export interface GeminiInteractionRequest {
    model?: string;
    agent?: string;
    input: GeminiInput;
    system_instruction?: string;
    tools?: GeminiTool[];
    response_format?: Record<string, unknown> | Array<Record<string, unknown>>;
    stream?: boolean;
    store?: boolean;
    background?: boolean;
    generation_config?: GeminiGenerationConfig;
    agent_config?: GeminiAgentConfig;
    previous_interaction_id?: string;
    response_modalities?: GeminiResponseModality[];
}

export type GeminiInteractionStatus = 'in_progress' | 'requires_action' | 'completed' | 'failed' | 'cancelled' | 'incomplete';

export interface GeminiInteractionResponse {
    id: string;
    model?: string;
    agent?: string;
    status: GeminiInteractionStatus;
    object: 'interaction';
    created: string;
    updated: string;
    steps?: GeminiStep[];
    /** Legacy response spellings accepted for backward compatibility. */
    role?: 'model';
    outputs?: GeminiContent[];
    errors?: Array<{ code?: string; message?: string }>;
    system_instruction?: string;
    tools?: GeminiTool[];
    usage?: GeminiUsage;
    response_modalities?: GeminiResponseModality[];
    previous_interaction_id?: string;
    input?: GeminiInput;
    response_format?: Record<string, unknown> | Array<Record<string, unknown>>;
    agent_config?: GeminiAgentConfig;
}

export interface GeminiSSEEvent {
    event_type: 'interaction.created' | 'interaction.completed' | 'interaction.status_update' | 'step.start' | 'step.delta' | 'step.stop' | 'error';
    event_id?: string;
    interaction?: GeminiInteractionResponse;
    interaction_id?: string;
    status?: GeminiInteractionStatus;
    index?: number;
    step?: GeminiStep;
    delta?: {
        type: string;
        text?: string;
        content?: GeminiContent;
        annotations?: GeminiAnnotation[];
        data?: string;
        uri?: string;
        mime_type?: string;
        resolution?: string;
        sample_rate?: number;
        channels?: number;
        signature?: string;
        partial_arguments?: string;
    };
    error?: { code: string; message: string };
}

export type GeminiModelOption =
    | 'gemini-4-hydrogen' | 'gemini-4-carbon' | 'gemini-4-carbon-cyber-permissive'
    | 'gemini-4-argon' | 'gemini-4-argon-cyber-permissive' | 'gemini-3.8-flash'
    | 'gemini-3.7-flash' | 'gemini-3.6-flash' | 'gemini-3.5-flash-lite'
    | 'gemini-3.1-pro-preview' | 'gemini-3.1-flash-lite' | 'gemini-omni-1.2-flash'
    | 'gemini-omni-1.1-flash-preview' | 'gemini-omni-flash-preview'
    | 'lyria-3-clip-preview' | 'lyria-3-pro-preview';

export type GeminiAgentOption = 'antigravity-preview-05-2026' | 'deep-research-preview-04-2026';
