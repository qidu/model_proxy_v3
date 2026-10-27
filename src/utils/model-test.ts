const TEST_TOOL_NAME = 'test_tool';
const TEST_TOOL_DESCRIPTION = 'test tool';
const TEST_TOOL_PROMPT = 'Use the test_tool and say hi.';
const TEST_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string' },
  },
  required: ['message'],
  additionalProperties: false,
};

function buildClaudeToolRequest(): Record<string, unknown> {
  return {
    messages: [{ role: 'user', content: TEST_TOOL_PROMPT }],
    max_tokens: 128,
    tools: [{ name: TEST_TOOL_NAME, description: TEST_TOOL_DESCRIPTION, input_schema: TEST_TOOL_SCHEMA }],
    tool_choice: { type: 'tool', name: TEST_TOOL_NAME },
  };
}

// `max_tokens` is rejected by the OpenAI Responses API ("Unsupported parameter:
// 'max_tokens' is not supported"), which expects `max_completion_tokens` instead.
// Map the parameter name per upstream mode so the test request is accepted as-is.
export function maxTokensField(upstreamMode: string): string {
  return (upstreamMode === 'openai-responses' || upstreamMode === 'open-responses') ? 'max_completion_tokens' : 'max_tokens';
}

function buildOpenAIToolRequest(upstreamMode: string): Record<string, unknown> {
  return {
    messages: [{ role: 'user', content: TEST_TOOL_PROMPT }],
    [maxTokensField(upstreamMode)]: 128,
    tools: [{
      type: 'function',
      function: {
        name: TEST_TOOL_NAME,
        description: TEST_TOOL_DESCRIPTION,
        parameters: TEST_TOOL_SCHEMA,
      },
    }],
    tool_choice: 'auto',
  };
}

const TEST_TEXT_PROMPT = 'Reply with one short sentence.';

export function buildTestTextRequest(upstreamMode: string): Record<string, unknown> {
  // Plain text, non-streaming — safe for fusion (panel responses must be text, not tool-call blobs,
  // and stream:false ensures the synth response is a buffered JSON body the TUI can parse).
  return {
    messages: [{ role: 'user', content: TEST_TEXT_PROMPT }],
    [maxTokensField(upstreamMode)]: 32,
    stream: false,
  };
}

export function buildTestToolRequest(upstreamMode: string): Record<string, unknown> {
  if (upstreamMode === 'openai-completions' ||
      upstreamMode === 'openai-responses' ||
      upstreamMode === 'open-responses' ||
      upstreamMode === 'gemini-generatecontent' ||
      upstreamMode === 'gemini-interactions') {
    return buildOpenAIToolRequest(upstreamMode);
  }

  const request = buildClaudeToolRequest();
  // No `thinking` block here. The TUI test is a liveness probe for the model
  // route, not a feature exercise. anthropic-messages upstreams that speak
  // the protocol natively (real Claude) accept the omission; compat shims
  // (e.g. DeepSeek's /anthropic endpoint) may reject or misinterpret the
  // `{"type": "adaptive"}` shape and surface 400s like
  // "Thinking mode does not support this tool_choice" when combined with a
  // forced `tool_choice`. See docs/guides/deepseek_thinking.md.
  return request;
}
