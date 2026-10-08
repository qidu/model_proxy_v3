

```bash
grep -rn "thinking_" src/ | claude -p "any thinking converting from upstream 'openai-completions' ot '/v1/messages' endpoint "
```

TODO: models emit do not `thinking_start` streaming events. The API wrapper doesn't convert downstream provider thinking output into Anthropic's `thinking_type` content block format.

Based on grep analysis of the codebase, here's a summary of the conversion from OpenAI `/v1/chat/completions` upstream to Claude `/v1/messages` endpoint:

## Key Conversion Points

### 1. Response Conversion (`src/converters/openai-to-claude.ts:103-184`)
- **stop_reason mapping**:
  - `stop` → `end_turn`
  - `length` → `max_tokens`
  - `tool_calls` → `tool_use`
  - `content_filter` → `content_filter`

- **Content blocks**: OpenAI's `message.content` (text) and `message.tool_calls` → Claude's `content: [{type: 'text' | 'tool_use', ...}]`

### 2. Streaming Conversion (`src/converters/streaming.ts:8-277`)
The `createStreamTransformer` function converts OpenAI SSE events to Claude SSE events:

| OpenAI Event | Claude Event |
|--------------|--------------|
| `data: {...}` with content | `content_block_delta` with `text_delta` |
| `reasoning_content` | `content_block_start` + `content_block_delta` with `thinking_delta` |
| `tool_calls` | `content_block_start` with `tool_use`, then `input_json_delta` |
| Stream end | `message_stop` |

### 3. Thinking Content Handling
When `includeThinking=true`, the converter:
1. Detects `delta.reasoning_content` or `delta.reasoning`
2. Creates a `thinking` content block
3. Sends `thinking_delta` events with the reasoning content

### 4. Token Counting
- OpenAI: `prompt_tokens`, `completion_tokens`
- Claude: `input_tokens`, `output_tokens`
- Also supports `prompt_cache_miss_tokens` / `prompt_cache_hit_tokens`
