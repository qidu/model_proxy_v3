# Models API

## Overview

The Models API response can be used to determine which models are available for use in the API. More recently released models are listed first.

**Endpoint:** `GET /v1/models`

## Request Parameters

### Query Parameters

#### `after_id: optional string`
ID of the object to use as a cursor for pagination. When provided, returns the page of results immediately after this object.

#### `before_id: optional string`
ID of the object to use as a cursor for pagination. When provided, returns the page of results immediately before this object.

#### `limit: optional number`
Number of items to return per page.

**Defaults:** `20`
**Range:** `1` to `1000`

### Header Parameters

#### `"anthropic-beta": optional array of AnthropicBeta`
Optional header to specify the beta version(s) you want to use.

**Beta Features:**
- `"message-batches-2024-09-24"`
- `"prompt-caching-2024-07-31"`
- `"computer-use-2024-10-22"`
- `"computer-use-2025-01-24"`
- `"pdfs-2024-09-25"`
- `"token-counting-2024-11-01"`
- `"token-efficient-tools-2025-02-19"`
- `"output-128k-2025-02-19"`
- `"files-api-2025-04-14"`
- `"mcp-client-2025-04-04"`
- `"mcp-client-2025-11-20"`
- `"dev-full-thinking-2025-05-14"`
- `"interleaved-thinking-2025-05-14"`
- `"code-execution-2025-05-22"`
- `"extended-cache-ttl-2025-04-11"`
- `"context-1m-2025-08-07"`
- `"context-management-2025-06-27"`
- `"model-context-window-exceeded-2025-08-26"`
- `"skills-2025-10-02"`

---

## Response Format

### Models List Response

```json
{
  "data": [
    {
      "id": "claude-sonnet-4-5-20250929",
      "type": "model",
      "created_at": "2025-09-29T00:00:00Z",
      "display_name": "Claude Sonnet 4.5"
    },
    {
      "id": "claude-3-5-haiku-20241022",
      "type": "model",
      "created_at": "2024-10-22T00:00:00Z",
      "display_name": "Claude 3.5 Haiku"
    }
  ],
  "first_id": "claude-sonnet-4-5-20250929",
  "has_more": false,
  "last_id": "claude-3-5-haiku-20241022"
}
```

### Response Fields:

#### `data: array of ModelInfo`
Array of model information objects.

**ModelInfo Fields:**
- `id: string` - Unique model identifier
- `created_at: string` - RFC 3339 datetime string representing the time at which the model was released. May be set to an epoch value if the release date is unknown.
- `display_name: string` - A human-readable name for the model
- `type: "model"` - Object type (always `"model"`)

#### `first_id: string`
First ID in the `data` list. Can be used as the `before_id` for the previous page.

#### `has_more: boolean`
Indicates if there are more results in the requested page direction.

#### `last_id: string`
Last ID in the `data` list. Can be used as the `after_id` for the next page.

---

## Available Models

### Current Models (as of 2025):

#### Premium Models:
- **`claude-opus-4-5-20251101`** - Premium model combining maximum intelligence with practical performance
- **`claude-opus-4-5`** - Premium model combining maximum intelligence with practical performance

#### High-Performance Models:
- **`claude-3-7-sonnet-latest`** - High-performance model with early extended thinking
- **`claude-3-7-sonnet-20250219`** - High-performance model with early extended thinking
- **`claude-sonnet-4-20250514`** - High-performance model with extended thinking
- **`claude-sonnet-4-0`** - High-performance model with extended thinking
- **`claude-4-sonnet-20250514`** - High-performance model with extended thinking
- **`claude-sonnet-4-5`** - Our best model for real-world agents and coding
- **`claude-sonnet-4-5-20250929`** - Our best model for real-world agents and coding

#### Fast Models:
- **`claude-3-5-haiku-latest`** - Fastest and most compact model for near-instant responsiveness
- **`claude-3-5-haiku-20241022`** - Our fastest model
- **`claude-haiku-4-5`** - Hybrid model, capable of near-instant responses and extended thinking
- **`claude-haiku-4-5-20251001`** - Hybrid model, capable of near-instant responses and extended thinking

#### Legacy Models:
- **`claude-opus-4-0`** - Our most capable model
- **`claude-opus-4-20250514`** - Our most capable model
- **`claude-4-opus-20250514`** - Our most capable model
- **`claude-opus-4-1-20250805`** - Our most capable model
- **`claude-3-opus-latest`** - Excels at writing and complex tasks
- **`claude-3-opus-20240229`** - Excels at writing and complex tasks
- **`claude-3-haiku-20240307`** - Our previous most fast and cost-effective

---

## Model Selection Guide

### Choose Based on Use Case:

#### 1. **Maximum Intelligence** (Complex reasoning, analysis)
- **Recommended**: `claude-opus-4-5-20251101`
- **Use cases**: Research, complex analysis, strategic planning
- **Characteristics**: Highest intelligence, best reasoning capabilities

#### 2. **Best Overall Performance** (General purpose, coding, agents)
- **Recommended**: `claude-sonnet-4-5-20250929`
- **Use cases**: Coding, real-world agents, general assistance
- **Characteristics**: Balanced performance, cost-effective

#### 3. **Maximum Speed** (Low latency, high throughput)
- **Recommended**: `claude-3-5-haiku-20241022`
- **Use cases**: Chat interfaces, real-time applications, high-volume processing
- **Characteristics**: Fastest response times, most cost-effective

#### 4. **Extended Thinking** (Complex problem solving)
- **Recommended**: `claude-3-7-sonnet-20250219`
- **Use cases**: Complex calculations, multi-step reasoning, detailed analysis
- **Characteristics**: Early extended thinking capabilities

---

## Usage Examples

### Basic Request

**cURL:**
```bash
curl https://api.anthropic.com/v1/models \
  -H 'anthropic-version: 2023-06-01' \
  -H "X-Api-Key: $ANTHROPIC_API_KEY"
```

**Python:**
```python
from anthropic import Anthropic

client = Anthropic()
models = client.models.list()
for model in models.data:
    print(f"{model.id}: {model.display_name}")
```

**JavaScript/TypeScript:**
```javascript
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();
const models = await anthropic.models.list();
models.data.forEach(model => {
  console.log(`${model.id}: ${model.display_name}`);
});
```

### Pagination Example

**First Page:**
```bash
curl "https://api.anthropic.com/v1/models?limit=10" \
  -H 'anthropic-version: 2023-06-01' \
  -H "X-Api-Key: $ANTHROPIC_API_KEY"
```

**Next Page:**
```bash
curl "https://api.anthropic.com/v1/models?limit=10&after_id=claude-3-5-haiku-20241022" \
  -H 'anthropic-version: 2023-06-01' \
  -H "X-Api-Key: $ANTHROPIC_API_KEY"
```

**Previous Page:**
```bash
curl "https://api.anthropic.com/v1/models?limit=10&before_id=claude-sonnet-4-5-20250929" \
  -H 'anthropic-version: 2023-06-01' \
  -H "X-Api-Key: $ANTHROPIC_API_KEY"
```

---

## Model Characteristics

### Performance Metrics:

| Model | Speed | Intelligence | Cost | Best For |
|-------|-------|-------------|------|----------|
| Claude Opus 4.5 | Slow | Highest | High | Complex reasoning, research |
| Claude Sonnet 4.5 | Medium | High | Medium | Coding, agents, general use |
| Claude 3.5 Haiku | Fast | Good | Low | Real-time chat, high volume |
| Claude 3.7 Sonnet | Medium | Very High | Medium-High | Extended thinking tasks |

### Feature Support:

| Feature | Opus 4.5 | Sonnet 4.5 | 3.5 Haiku | 3.7 Sonnet |
|---------|----------|------------|-----------|------------|
| Extended Thinking | ✓ | ✓ | ✓ | ✓ (early) |
| Tool Use | ✓ | ✓ | ✓ | ✓ |
| Image Understanding | ✓ | ✓ | ✓ | ✓ |
| Document Processing | ✓ | ✓ | ✓ | ✓ |
| Streaming | ✓ | ✓ | ✓ | ✓ |
| Batch Processing | ✓ | ✓ | ✓ | ✓ |

---

## Model Updates

### Release Strategy:
- **New models**: Released periodically with improved capabilities
- **Model versions**: Include date stamps (e.g., `20250929`)
- **Backward compatibility**: Older models remain available
- **Deprecation**: Models are deprecated when significantly improved versions are available

### Checking for Updates:
1. Call the Models API regularly
2. Monitor release notes and announcements
3. Test new models in staging environments
4. Plan migrations for deprecated models

---

## Error Handling

### Common Errors:

| Error Type | HTTP Status | Description |
|------------|-------------|-------------|
| `invalid_request` | 400 | Invalid query parameters |
| `authentication_error` | 401 | Invalid API key |
| `rate_limit_exceeded` | 429 | Too many requests |
| `server_error` | 500 | Internal server error |

### Example Error Response:
```json
{
  "type": "error",
  "error": {
    "type": "rate_limit_exceeded",
    "message": "Rate limit exceeded"
  }
}
```

---

## Best Practices

### 1. Model Selection
- **Test multiple models** for your specific use case
- **Consider cost-performance tradeoffs**
- **Monitor model performance** over time
- **Stay updated** on new model releases

### 2. Caching
- **Cache model lists** to reduce API calls
- **Set appropriate TTL** (e.g., 1 hour)
- **Invalidate cache** when models change

### 3. Monitoring
- **Track model usage** by application
- **Monitor performance metrics**
- **Set alerts** for model deprecations

### 4. Migration Planning
- **Test new models** before adoption
- **Plan gradual rollouts**
- **Maintain backward compatibility**
- **Update documentation** and code references

---

## Integration Examples

### Dynamic Model Selection:

```python
from anthropic import Anthropic

client = Anthropic()

def get_best_model(use_case):
    """Select the best model based on use case."""
    models = client.models.list()

    if use_case == "complex_reasoning":
        return "claude-opus-4-5-20251101"
    elif use_case == "coding":
        return "claude-sonnet-4-5-20250929"
    elif use_case == "real_time":
        return "claude-3-5-haiku-20241022"
    else:
        # Default to most recent model
        return models.data[0].id

# Usage
model_id = get_best_model("coding")
response = client.messages.create(
    model=model_id,
    max_tokens=1024,
    messages=[{"role": "user", "content": "Write a Python function"}]
)
```

### Model Availability Check:

```javascript
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

async function isModelAvailable(modelId) {
  try {
    const models = await anthropic.models.list();
    return models.data.some(model => model.id === modelId);
  } catch (error) {
    console.error('Error checking model availability:', error);
    return false;
  }
}

// Usage
const available = await isModelAvailable('claude-sonnet-4-5-20250929');
if (available) {
  // Use the model
}
```

---

## Next Steps

- [Messages API](messages-api.md): Using models for conversations
- [Token Counting API](token-counting-api.md): Estimating token usage
- [Rate Limits](rate-limits.md): Understanding usage tiers
- [Examples](../examples/): Code samples and tutorials