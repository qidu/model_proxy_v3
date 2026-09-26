# Token Counting API

## Overview

The Token Count API can be used to count the number of tokens in a Message, including tools, images, and documents, without creating it. This helps manage costs and rate limits by estimating token usage before sending requests.

**Endpoint:** `POST /v1/messages/count_tokens`

## Request Parameters

### Body Parameters

#### `messages: array of MessageParam`
Input messages for token counting.

Our models are trained to operate on alternating `user` and `assistant` conversational turns. When creating a new `Message`, you specify the prior conversational turns with the `messages` parameter, and the model then generates the next `Message` in the conversation. Consecutive `user` or `assistant` turns in your request will be combined into a single turn.

Each input message must be an object with a `role` and `content`. You can specify a single `user`-role message, or you can include multiple `user` and `assistant` messages.

If the final message uses the `assistant` role, the response content will continue immediately from the content in that message. This can be used to constrain part of the model's response.

**Example with a single `user` message:**
```json
[{"role": "user", "content": "Hello, Claude"}]
```

**Example with multiple conversational turns:**
```json
[
  {"role": "user", "content": "Hello there."},
  {"role": "assistant", "content": "Hi, I'm Claude. How can I help you?"},
  {"role": "user", "content": "Can you explain LLMs in plain English?"}
]
```

**Example with a partially-filled response from Claude:**
```json
[
  {
    "role": "user",
    "content": "What's the Greek name for Sun? (A) Sol (B) Helios (C) Sun"
  },
  {
    "role": "assistant",
    "content": "The best answer is ("
  }
]
```

#### `model: Model`
The model that will complete your prompt.

See [models overview](https://docs.anthropic.com/en/docs/models-overview) for additional details and options.

**Available Models:**
- `"claude-opus-4-5-20251101"` - Premium model combining maximum intelligence with practical performance
- `"claude-opus-4-5"` - Premium model combining maximum intelligence with practical performance
- `"claude-3-7-sonnet-latest"` - High-performance model with early extended thinking
- `"claude-3-7-sonnet-20250219"` - High-performance model with early extended thinking
- `"claude-3-5-haiku-latest"` - Fastest and most compact model for near-instant responsiveness
- `"claude-3-5-haiku-20241022"` - Our fastest model
- `"claude-haiku-4-5"` - Hybrid model, capable of near-instant responses and extended thinking
- `"claude-haiku-4-5-20251001"` - Hybrid model, capable of near-instant responses and extended thinking
- `"claude-sonnet-4-20250514"` - High-performance model with extended thinking
- `"claude-sonnet-4-0"` - High-performance model with extended thinking
- `"claude-4-sonnet-20250514"` - High-performance model with extended thinking
- `"claude-sonnet-4-5"` - Our best model for real-world agents and coding
- `"claude-sonnet-4-5-20250929"` - Our best model for real-world agents and coding
- `"claude-opus-4-0"` - Our most capable model
- `"claude-opus-4-20250514"` - Our most capable model
- `"claude-4-opus-20250514"` - Our most capable model
- `"claude-opus-4-1-20250805"` - Our most capable model
- `"claude-3-opus-latest"` - Excels at writing and complex tasks
- `"claude-3-opus-20240229"` - Excels at writing and complex tasks
- `"claude-3-haiku-20240307"` - Our previous most fast and cost-effective

#### `system: optional string | array of TextBlockParam`
System prompt for token counting.

A system prompt is a way of providing context and instructions to Claude, such as specifying a particular goal or role. See our [guide to system prompts](https://docs.claude.com/en/docs/system-prompts).

**Examples:**
```json
{
  "system": "You are a helpful assistant."
}
```

```json
{
  "system": [
    {
      "type": "text",
      "text": "You are an expert in computer science."
    }
  ]
}
```

#### `thinking: optional ThinkingConfigParam`
Configuration for enabling Claude's extended thinking token counting.

When enabled, token counting includes `thinking` content blocks showing Claude's thinking process before the final answer. Requires a minimum budget of 1,024 tokens and counts towards your `max_tokens` limit.

See [extended thinking](https://docs.claude.com/en/docs/build-with-claude/extended-thinking) for details.

**Example:**
```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 10000
  }
}
```

#### `tool_choice: optional ToolChoice`
How the model should use the provided tools for token counting.

The model can use a specific tool, any available tool, decide by itself, or not use tools at all.

**Options:**
- `{"type": "auto"}` - Model decides (default)
- `{"type": "any"}` - Use any available tool
- `{"type": "tool", "name": "tool_name"}` - Use specific tool
- `{"type": "none"}` - Disable tool use

#### `tools: optional array of MessageCountTokensTool`
Definitions of tools that the model may use for token counting.

If you include `tools` in your API request, the model may return `tool_use` content blocks that represent the model's use of those tools. You can then run those tools using the tool input generated by the model and then optionally return results back to the model using `tool_result` content blocks.

**Tool Types:**
- **Client tools**: Custom tools defined by you
- **Server tools**: Built-in tools like web search

**Example Tool Definition:**
```json
{
  "tools": [
    {
      "name": "get_stock_price",
      "description": "Get the current stock price for a given ticker symbol.",
      "input_schema": {
        "type": "object",
        "properties": {
          "ticker": {
            "type": "string",
            "description": "The stock ticker symbol, e.g. AAPL for Apple Inc."
          }
        },
        "required": ["ticker"]
      }
    }
  ]
}
```

---

## Response Format

### MessageTokensCount Object

```json
{
  "input_tokens": 125
}
```

#### Fields:

- `input_tokens: number` - The total number of tokens across the provided list of messages, system prompt, and tools.

---

## Usage Examples

### Basic Token Counting

**Request:**
```bash
curl https://api.anthropic.com/v1/messages/count_tokens \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -H "X-Api-Key: $ANTHROPIC_API_KEY" \
  -d '{
    "messages": [
      {
        "content": "Hello, Claude",
        "role": "user"
      }
    ],
    "model": "claude-opus-4-5-20251101"
  }'
```

**Response:**
```json
{
  "input_tokens": 12
}
```

### Token Counting with System Prompt

**Request:**
```bash
curl https://api.anthropic.com/v1/messages/count_tokens \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -H "X-Api-Key: $ANTHROPIC_API_KEY" \
  -d '{
    "messages": [
      {
        "content": "Explain quantum computing",
        "role": "user"
      }
    ],
    "model": "claude-sonnet-4-5-20250929",
    "system": "You are a physics professor."
  }'
```

### Token Counting with Tools

**Request:**
```bash
curl https://api.anthropic.com/v1/messages/count_tokens \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -H "X-Api-Key: $ANTHROPIC_API_KEY" \
  -d '{
    "messages": [
      {
        "content": "What's the weather in San Francisco?",
        "role": "user"
      }
    ],
    "model": "claude-3-5-haiku-20241022",
    "tools": [
      {
        "name": "get_weather",
        "description": "Get current weather for a location",
        "input_schema": {
          "type": "object",
          "properties": {
            "location": {
              "type": "string",
              "description": "City name or coordinates"
            }
          },
          "required": ["location"]
        }
      }
    ]
  }'
```

---

## Token Counting Details

### What's Included:
- **Message text**: All text content in messages
- **System prompt**: Text in system parameter
- **Tool definitions**: JSON schema and descriptions
- **Image content**: Token representation of images
- **Document content**: Token representation of documents
- **Thinking budget**: If thinking is enabled

### What's Not Included:
- **Output tokens**: Only input tokens are counted
- **Response content**: This is a pre-calculation only
- **Metadata**: Request metadata not included in count

---

## Best Practices

### 1. Cost Management
- Count tokens before sending large requests
- Estimate costs based on token counts
- Set budgets and limits based on token usage

### 2. Rate Limit Planning
- Monitor token usage per minute
- Plan batch sizes based on token limits
- Avoid rate limit errors with pre-calculation

### 3. Request Optimization
- Trim unnecessary content before sending
- Use efficient message formatting
- Consider token-efficient alternatives

### 4. Monitoring
- Track token usage trends
- Set alerts for high token counts
- Analyze token efficiency over time

---

## Common Use Cases

### 1. Budget Planning
- Estimate costs for large projects
- Set per-request token limits
- Monitor spending against budgets

### 2. Rate Limit Management
- Ensure requests stay within limits
- Plan batch processing schedules
- Avoid service interruptions

### 3. Performance Optimization
- Identify token-heavy content
- Optimize message formatting
- Improve response efficiency

### 4. Quality Control
- Ensure requests fit context windows
- Avoid truncation of important content
- Maintain conversation quality

---

## Error Handling

### Common Errors:

| Error Type | HTTP Status | Description |
|------------|-------------|-------------|
| `invalid_request` | 400 | Invalid request parameters |
| `authentication_error` | 401 | Invalid API key |
| `rate_limit_exceeded` | 429 | Too many token counting requests |
| `server_error` | 500 | Internal server error |

### Example Error Response:
```json
{
  "type": "error",
  "error": {
    "type": "invalid_request",
    "message": "Missing required parameter: messages"
  }
}
```

---

## Integration Examples

### Python Example:
```python
from anthropic import Anthropic

client = Anthropic()

# Count tokens before sending
token_count = client.messages.count_tokens(
    model="claude-sonnet-4-5-20250929",
    messages=[
        {"role": "user", "content": "Hello, Claude"}
    ],
    system="You are a helpful assistant."
)

print(f"Token count: {token_count.input_tokens}")

# Send message if within budget
if token_count.input_tokens < 1000:
    response = client.messages.create(
        model="claude-sonnet-4-5-20250929",
        max_tokens=1024,
        messages=[
            {"role": "user", "content": "Hello, Claude"}
        ],
        system="You are a helpful assistant."
    )
```

### JavaScript/TypeScript Example:
```javascript
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

// Count tokens before sending
const tokenCount = await anthropic.messages.countTokens({
  model: 'claude-sonnet-4-5-20250929',
  messages: [
    { role: 'user', content: 'Hello, Claude' }
  ],
  system: 'You are a helpful assistant.'
});

console.log(`Token count: ${tokenCount.input_tokens}`);

// Send message if within budget
if (tokenCount.input_tokens < 1000) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 1024,
    messages: [
      { role: 'user', content: 'Hello, Claude' }
    ],
    system: 'You are a helpful assistant.'
  });
}
```

---

## Next Steps

- [Messages API](messages-api.md): Send messages to Claude
- [Message Batches API](batches-api.md): Process large volumes efficiently
- [Rate Limits](rate-limits.md): Understanding usage tiers
- [Examples](../examples/): Code samples and tutorials