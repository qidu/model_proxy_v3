# Message Batches API

## Overview

The Message Batches API can be used to process multiple Messages API requests at once. Once a Message Batch is created, it begins processing immediately. Batches can take up to 24 hours to complete.

**Endpoint:** `POST /v1/messages/batches`

## Request Parameters

### Body Parameters

#### `requests: array of object { custom_id, params }`
List of requests for prompt completion. Each is an individual request to create a Message.

**Structure:**
```json
{
  "requests": [
    {
      "custom_id": "my-custom-id-1",
      "params": {
        "max_tokens": 1024,
        "messages": [
          {
            "content": "Hello, world",
            "role": "user"
          }
        ],
        "model": "claude-sonnet-4-5-20250929"
      }
    },
    {
      "custom_id": "my-custom-id-2",
      "params": {
        "max_tokens": 512,
        "messages": [
          {
            "content": "Explain AI in simple terms",
            "role": "user"
          }
        ],
        "model": "claude-3-5-haiku-20241022"
      }
    }
  ]
}
```

#### `custom_id: string`
Developer-provided ID created for each request in a Message Batch. Useful for matching results to requests, as results may be given out of request order.

**Requirements:**
- Must be unique for each request within the Message Batch
- Used to match results to original requests
- Results are not guaranteed to be in the same order as requests

#### `params: object { max_tokens, messages, model, ... }`
Messages API creation parameters for the individual request.

See the [Messages API reference](messages-api.md) for full documentation on available parameters.

**Required Parameters:**
- `max_tokens: number` - Maximum tokens to generate
- `messages: array of MessageParam` - Input messages
- `model: Model` - Model identifier

**Optional Parameters:**
- `system: string | TextBlockParam[]` - System prompt
- `temperature: number` - Randomness control (0.0-1.0)
- `top_p: number` - Nucleus sampling
- `top_k: number` - Top K sampling
- `stop_sequences: string[]` - Custom stop sequences
- `stream: boolean` - Enable streaming
- `thinking: ThinkingConfigParam` - Extended thinking
- `tool_choice: ToolChoice` - Tool usage control
- `tools: Tool[]` - Tool definitions
- `metadata: Metadata` - Request metadata
- `service_tier: "auto" | "standard_only"` - Service tier

---

## Response Format

### MessageBatch Object

```json
{
  "id": "batch_...",
  "type": "message_batch",
  "created_at": "2025-01-21T14:33:00Z",
  "expires_at": "2025-01-22T14:33:00Z",
  "processing_status": "in_progress",
  "request_counts": {
    "processing": 10,
    "succeeded": 0,
    "errored": 0,
    "canceled": 0,
    "expired": 0
  }
}
```

#### Fields:

- `id: string` - Unique object identifier
- `type: "message_batch"` - Object type (always "message_batch")
- `archived_at: string` - RFC 3339 datetime when batch was archived
- `cancel_initiated_at: string` - RFC 3339 datetime when cancellation was initiated
- `created_at: string` - RFC 3339 datetime when batch was created
- `ended_at: string` - RFC 3339 datetime when processing ended
- `expires_at: string` - RFC 3339 datetime when batch expires (24 hours after creation)
- `processing_status: "in_progress" | "canceling" | "ended"` - Processing status
- `request_counts: MessageBatchRequestCounts` - Request status tallies
- `results_url: string` - URL to `.jsonl` file containing results

#### Request Counts:

```json
{
  "request_counts": {
    "processing": 5,
    "succeeded": 3,
    "errored": 1,
    "canceled": 1,
    "expired": 0
  }
}
```

- `processing: number` - Requests currently processing
- `succeeded: number` - Requests completed successfully
- `errored: number` - Requests that encountered errors
- `canceled: number` - Requests that were canceled
- `expired: number` - Requests that expired

---

## Processing Status

### Status Values:

1. **`in_progress`** - Batch is currently processing
   - Requests are being executed
   - Results are not yet available
   - Can be canceled

2. **`canceling`** - Batch cancellation has been initiated
   - Processing will stop
   - Partial results may be available
   - Cannot be resumed

3. **`ended`** - Batch processing has completed
   - All requests have final status
   - Results are available via `results_url`
   - Cannot be modified

---

## Results Format

### Results File:
- **Format**: `.jsonl` (JSON Lines)
- **Location**: `results_url` provided in response
- **Order**: Not guaranteed to match request order
- **Matching**: Use `custom_id` to match results to requests

### Example Result Entry:
```json
{
  "custom_id": "my-custom-id-1",
  "type": "message",
  "response": {
    "id": "msg_...",
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "text",
        "text": "Hello! How can I assist you today?"
      }
    ],
    "model": "claude-sonnet-4-5-20250929",
    "stop_reason": "end_turn",
    "usage": {
      "input_tokens": 12,
      "output_tokens": 8
    }
  },
  "error": null
}
```

### Error Result Entry:
```json
{
  "custom_id": "my-custom-id-2",
  "type": "error",
  "response": null,
  "error": {
    "type": "rate_limit_exceeded",
    "message": "Rate limit exceeded"
  }
}
```

---

## Batch Lifecycle

### 1. Creation
- Batch created with `POST /v1/messages/batches`
- Initial status: `in_progress`
- Processing begins immediately
- Expires 24 hours after creation

### 2. Processing
- Requests executed in parallel
- Status updates available via polling
- Can be canceled during processing

### 3. Completion
- All requests reach final status
- Status changes to `ended`
- Results available via `results_url`
- Archived after results are downloaded

### 4. Expiration
- Batch expires 24 hours after creation
- Results become unavailable
- Batch is archived

---

## Cost and Performance

### Benefits:
- **50% cost reduction** compared to individual Messages API calls
- **Asynchronous processing** - don't wait for each request
- **High throughput** - process large volumes efficiently
- **Batch management** - track progress and results

### Considerations:
- **Processing time**: Up to 24 hours for completion
- **Results access**: Available via URL for limited time
- **Error handling**: Individual request failures don't stop batch
- **Monitoring**: Poll for status updates

---

## Example Request

```bash
curl https://api.anthropic.com/v1/messages/batches \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -H "X-Api-Key: $ANTHROPIC_API_KEY" \
  -d '{
    "requests": [
      {
        "custom_id": "request-1",
        "params": {
          "max_tokens": 1024,
          "messages": [
            {
              "content": "Hello, Claude",
              "role": "user"
            }
          ],
          "model": "claude-sonnet-4-5-20250929",
          "temperature": 0.7
        }
      },
      {
        "custom_id": "request-2",
        "params": {
          "max_tokens": 512,
          "messages": [
            {
              "content": "What is machine learning?",
              "role": "user"
            }
          ],
          "model": "claude-3-5-haiku-20241022",
          "temperature": 0.5
        }
      }
    ]
  }'
```

---

## Error Handling

### Common Errors:

| Error Type | HTTP Status | Description |
|------------|-------------|-------------|
| `invalid_request` | 400 | Invalid request parameters |
| `rate_limit_exceeded` | 429 | Too many batch requests |
| `batch_too_large` | 413 | Batch exceeds size limits |
| `processing_error` | 500 | Internal processing error |

### Batch-Level Errors:
- Returned immediately on batch creation
- Prevent batch from starting
- Include validation errors

### Request-Level Errors:
- Individual request failures
- Don't affect other requests
- Recorded in results file

---

## Best Practices

### 1. Batch Size
- **Optimal**: 100-1000 requests per batch
- **Maximum**: Follow API limits
- **Consideration**: Larger batches may take longer

### 2. Custom IDs
- Use descriptive, unique identifiers
- Include metadata (e.g., "user-123-query-1")
- Support result matching and tracking

### 3. Monitoring
- Poll for status updates
- Track request counts
- Download results promptly

### 4. Error Handling
- Expect individual request failures
- Implement retry logic for transient errors
- Log and analyze error patterns

### 5. Cost Optimization
- Use for non-real-time processing
- Batch similar requests together
- Monitor usage and costs

---

## Next Steps

- [Messages API](messages-api.md): Individual message requests
- [Token Counting API](token-counting-api.md): Pre-calculate token usage
- [Examples](../examples/): Code samples and tutorials
- [Rate Limits](rate-limits.md): Understanding usage tiers