# streamGenerateContent Endpoint Analysis

## Date: 2026-02-26

## Question

**Does the proxy support `/v1beta/models/{model}:streamGenerateContent` endpoint (the SSE variant of generateContent)?**

## Answer: ❌ NO - Not Currently Supported

The proxy **does not** currently support the `:streamGenerateContent` endpoint. Only `:generateContent` is supported.

---

## Background: Gemini API Endpoints

### Two Separate Endpoints

According to [Gemini API documentation](https://ai.google.dev/docs/gemini_api_overview):

**1. generateContent** - Standard REST endpoint
- Returns single complete response
- Can optionally enable streaming via `stream: true` parameter
- Endpoint: `/v1beta/models/{model}:generateContent`

**2. streamGenerateContent** - Dedicated SSE endpoint
- Always returns streaming response via Server-Sent Events
- Optimized for real-time applications (chatbots)
- Endpoint: `/v1beta/models/{model}:streamGenerateContent`

### Key Difference

Content was rephrased for compliance with licensing restrictions:
- `generateContent` is a general-purpose endpoint that can work in both buffered and streaming modes
- `streamGenerateContent` is specifically designed for SSE streaming only

---

## Current Implementation

### Routing (src/index.ts)

```typescript
// Lines 184-210
// 3. /v1beta/models/{model}:generateContent → 2 upstream modes
if (path.startsWith('/v1beta/models/') && path.includes(':generateContent')) {
  const modelMatch = path.match(/\/v1beta\/models\/([^:?]+):generateContent/);
  const modelId = modelMatch ? modelMatch[1] : 'gemini-pro';
  const mode = (env.GENERATE_CONTENT_UPSTREAM_MODE || 'native') as 'native' | 'openai-completions';
  
  if (mode === 'native') {
    // Native Gemini generateContent
    const baseUrl = env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
    const apiVersion = env.GEMINI_API_VERSION || 'v1beta';
    return {
      targetUrl: `${baseUrl}/${apiVersion}/models/${modelId}:generateContent`,
      targetEndpoint: 'v1beta/models/generateContent',
      handlerType: 'generateContent',
      upstreamMode: 'native',
      modelId,
    };
  } else {
    // OpenAI-compatible upstream
    const baseUrl = env.FIXED_ROUTE_TARGET_URL || 'https://api.example.com';
    const pathPrefix = env.FIXED_ROUTE_PATH_PREFIX || '';
    return {
      targetUrl: `${baseUrl}${pathPrefix}/v1/chat/completions`,
      targetEndpoint: 'v1beta/models/generateContent',
      handlerType: 'generateContent',
      upstreamMode: 'openai-completions',
      modelId,
    };
  }
}
```

**What's Missing:**
- No check for `:streamGenerateContent` in the path
- Pattern only matches `:generateContent`
- No separate routing for streamGenerateContent endpoint

### Search Results

```bash
grep -r "streamGenerateContent" src/
# No matches found
```

**Conclusion:** The `:streamGenerateContent` endpoint is not implemented.

---

## What Currently Works

### ✅ generateContent with stream parameter

**Client Request:**
```bash
POST /v1beta/models/gemini-2.5-flash:generateContent
{
  "contents": [...],
  "stream": true  # Enable streaming via parameter
}
```

**Proxy Behavior:**
1. Routes to `handleOpenAIRequest()` (if OpenAI mode)
2. Converts to OpenAI format with `stream: true`
3. Sends to upstream: `POST /v1/chat/completions`
4. Returns SSE stream to client

**Result:** ✅ Works correctly (see `docs/generatecontent_sse_flow_analysis.md`)

---

## What Doesn't Work

### ❌ streamGenerateContent endpoint

**Client Request:**
```bash
POST /v1beta/models/gemini-2.5-flash:streamGenerateContent
{
  "contents": [...]
}
```

**Proxy Behavior:**
1. Path doesn't match any routing pattern
2. Falls through to error: `Unsupported fixed route`

**Result:** ❌ Returns 404 or routing error

---

## Implementation Plan

### Option 1: Add Separate Route (Recommended)

**Changes needed in src/index.ts:**

```typescript
// Add after generateContent routing (line 210)

// 3b. /v1beta/models/{model}:streamGenerateContent → Always streaming
if (path.startsWith('/v1beta/models/') && path.includes(':streamGenerateContent')) {
  const modelMatch = path.match(/\/v1beta\/models\/([^:?]+):streamGenerateContent/);
  const modelId = modelMatch ? modelMatch[1] : 'gemini-no-id-at-proxy';
  const mode = (env.GENERATE_CONTENT_UPSTREAM_MODE || 'native') as 'native' | 'openai-completions';
  
  if (mode === 'native') {
    // Native Gemini streamGenerateContent
    const baseUrl = env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
    const apiVersion = env.GEMINI_API_VERSION || 'v1beta';
    return {
      targetUrl: `${baseUrl}/${apiVersion}/models/${modelId}:streamGenerateContent`,
      targetEndpoint: 'v1beta/models/streamGenerateContent',
      handlerType: 'streamGenerateContent',  // New handler type
      upstreamMode: 'native',
      modelId,
    };
  } else {
    // OpenAI-compatible upstream (always streaming)
    const baseUrl = env.FIXED_ROUTE_TARGET_URL || 'https://api.example.com';
    const pathPrefix = env.FIXED_ROUTE_PATH_PREFIX || '';
    return {
      targetUrl: `${baseUrl}${pathPrefix}/v1/chat/completions`,
      targetEndpoint: 'v1beta/models/streamGenerateContent',
      handlerType: 'streamGenerateContent',
      upstreamMode: 'openai-completions',
      modelId,
    };
  }
}
```

**Handler routing (add to switch statement):**

```typescript
case 'streamGenerateContent':
  // Force streaming mode
  if (upstreamMode === 'native') {
    response = await handleGeminiRequest(request, targetUrl, modelAuthHeaders, requestId, modelId, env, logger);
  } else {
    // Force stream: true in request
    response = await handleOpenAIRequest(request, targetUrl, modelAuthHeaders, requestId, modelId, env, logger);
  }
  break;
```

**Handler modification (src/handlers/openai.ts):**

```typescript
// In handleOpenAIRequest, detect streamGenerateContent
const url = new URL(request.url);
const isStreamGenerateContent = url.pathname.includes(':streamGenerateContent');

// Force streaming for streamGenerateContent
if (isStreamGenerateContent) {
  openaiRequest.stream = true;
  isStreaming = true;
}
```

### Option 2: Unified Route (Simpler)

**Modify existing pattern to match both:**

```typescript
// Match both :generateContent and :streamGenerateContent
if (path.startsWith('/v1beta/models/') && 
    (path.includes(':generateContent') || path.includes(':streamGenerateContent'))) {
  
  const modelMatch = path.match(/\/v1beta\/models\/([^:?]+):(stream)?generateContent/);
  const modelId = modelMatch ? modelMatch[1] : 'gemini-no-id-at-proxy';
  const isStreamEndpoint = path.includes(':streamGenerateContent');
  
  // ... rest of routing logic
  
  return {
    targetUrl: ...,
    targetEndpoint: isStreamEndpoint ? 'v1beta/models/streamGenerateContent' : 'v1beta/models/generateContent',
    handlerType: 'generateContent',  // Reuse existing handler
    upstreamMode: ...,
    modelId,
    forceStreaming: isStreamEndpoint,  // New flag
  };
}
```

**Handler uses forceStreaming flag:**

```typescript
// In handleOpenAIRequest
if (routeInfo.forceStreaming) {
  openaiRequest.stream = true;
  isStreaming = true;
}
```

---

## Recommendation

### Option 2: Unified Route ✅

**Why:**
1. **Minimal code changes** - Reuses existing handlers
2. **Consistent behavior** - Both endpoints use same conversion logic
3. **Simple maintenance** - Single code path for both variants
4. **Backward compatible** - Doesn't break existing generateContent

**Implementation:**
1. Update routing pattern to match both endpoints
2. Add `forceStreaming` flag for streamGenerateContent
3. Force `stream: true` in request conversion
4. Test both endpoints

---

## Testing Plan

### Test Cases

**1. streamGenerateContent with native mode:**
```bash
POST /v1beta/models/gemini-2.5-flash:streamGenerateContent
→ Should route to native Gemini API
→ Should return SSE stream
```

**2. streamGenerateContent with OpenAI mode:**
```bash
POST /v1beta/models/gemini-2.5-flash:streamGenerateContent
→ Should convert to OpenAI format with stream: true
→ Should return SSE stream
```

**3. Backward compatibility:**
```bash
POST /v1beta/models/gemini-2.5-flash:generateContent
{"stream": true}
→ Should still work as before
```

---

## Summary

### Current Status: ❌ Not Supported

**What works:**
- ✅ `/v1beta/models/{model}:generateContent` with `stream: true` parameter

**What doesn't work:**
- ❌ `/v1beta/models/{model}:streamGenerateContent` endpoint

### Recommendation: Add Support

**Approach:** Unified route (Option 2)
- Modify routing pattern to match both endpoints
- Add `forceStreaming` flag
- Reuse existing handlers
- Minimal code changes

**Effort:** Low (< 50 lines of code)

**Priority:** Medium
- Not critical (generateContent with stream parameter works)
- Nice to have for Gemini API compatibility
- Some clients may expect this endpoint

---

## Related Files

- `src/index.ts` - Routing logic (needs update)
- `src/handlers/openai.ts` - Request handler (minor update)
- `src/handlers/gemini.ts` - Native Gemini handler (works as-is)
- `docs/generatecontent_sse_flow_analysis.md` - Current generateContent SSE flow
- `docs/routing_refactor.md` - Routing architecture

---

## References

Here's what I found:

[1] Google AI for Developers - https://ai.google.dev/docs/gemini_api_overview
[2] Gemini Streaming Architecture — GeminiEx v0.9.1 - https://hexdocs.pm/gemini_ex/streaming.html
[3] Mastering Audio Transcription With Gemini APIs - https://dzone.com/articles/mastering-audio-transcription-with-gemini-apis
