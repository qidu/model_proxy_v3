# Context Caching Support

**Implementation Date:** 2026-02-28

## Overview

The proxy now supports Gemini's `cachedContent` parameter for context caching across all three API endpoints. This allows reusing precomputed input tokens for cost and latency savings.

## API Support

### 1. Claude Messages API (`/v1/messages`)

```bash
curl -X POST http://localhost:8788/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-key" \
  -d '{
    "model": "gemini-2.5-flash",
    "max_tokens": 1000,
    "messages": [{
      "role": "user",
      "content": "Summarize the document"
    }],
    "cached_content": "cachedContents/abc123"
  }'
```

### 2. Interactions API (`/v1/interactions`)

```bash
curl -X POST http://localhost:8788/v1/interactions \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: your-key" \
  -d '{
    "model": "gemini-2.5-flash",
    "input": "What is in the cached content?",
    "cached_content": "cachedContents/abc123"
  }'
```

### 3. Native Gemini API (`/v1beta/models/{model}:generateContent`)

```bash
curl -X POST http://localhost:8788/v1beta/models/gemini-2.5-flash:generateContent \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: your-key" \
  -d '{
    "contents": [{
      "role": "user",
      "parts": [{"text": "Analyze this"}]
    }],
    "cachedContent": "cachedContents/abc123"
  }'
```

## Implementation Details

### Type Definitions

**Gemini Types** (`src/types/gemini.ts`):
```typescript
export interface GeminiInteractionRequest {
  // ... other fields
  cached_content?: string;
}
```

**Claude Types** (`src/types/claude.ts`):
```typescript
export interface ClaudeMessagesRequest {
  // ... other fields
  cached_content?: string;
}
```

### Request Flow

1. **Client sends request** with `cached_content` parameter
2. **Proxy receives** and validates the request
3. **Converter** passes through `cached_content` → `cachedContent`
4. **Upstream API** uses the cached content reference

### Code Changes

**Files Modified:**
- `src/types/gemini.ts` - Added `cached_content` field
- `src/types/claude.ts` - Added `cached_content` field
- `src/handlers/gemini.ts` - Pass-through in Interactions handler
- `src/converters/claude-to-gemini.ts` - Pass-through in converter

## Usage with Gemini CLI

If using Gemini CLI with cached content:

```bash
# Create cache (using Gemini API directly)
CACHE_ID=$(curl -X POST https://generativelanguage.googleapis.com/v1beta/cachedContents \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "models/gemini-2.5-flash",
    "contents": [{
      "role": "user",
      "parts": [{"text": "Large document content here..."}]
    }],
    "ttl": "3600s"
  }' | jq -r '.name')

# Use cache through proxy
curl -X POST http://localhost:8788/v1/messages \
  -H "x-api-key: your-key" \
  -d "{
    \"model\": \"gemini-2.5-flash\",
    \"max_tokens\": 100,
    \"messages\": [{\"role\": \"user\", \"content\": \"Summarize\"}],
    \"cached_content\": \"$CACHE_ID\"
  }"
```

## Benefits

1. **Cost Savings**: Cached tokens are cheaper than regular input tokens
2. **Latency Reduction**: Precomputed tokens reduce processing time
3. **API Compatibility**: Works across all three proxy endpoints
4. **Transparent**: No special configuration needed

## Limitations

- Cache management (create/list/delete) must be done directly with Gemini API
- Cache IDs must be obtained from upstream Gemini API
- TTL and expiration managed by upstream

## Testing

Run the test suite:
```bash
./tests/test_cached_content.sh
```

## References

- [Gemini Context Caching Guide](https://ai.google.dev/gemini-api/docs/caching)
- [Gemini Caching API Reference](https://ai.google.dev/api/caching)
