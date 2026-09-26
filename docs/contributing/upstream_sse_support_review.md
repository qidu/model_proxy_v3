# Upstream Handlers SSE Support Review

## Date: 2026-02-25

## Executive Summary

**Upstream handlers have mixed SSE streaming support:**

| Handler | Streaming Support | Status | Notes |
|---------|------------------|--------|-------|
| handleClaudeRequest | ✅ Yes | Working | Pass-through response.body |
| handleMessagesRequest | ✅ Yes | Working | Checks stream, handles properly |
| handleOpenAIRequest | ✅ Yes | Working | Checks stream, handles properly |
| handleGeminiGenerateContentRequest | ✅ Yes | Working | Checks stream, handles properly |
| handleGeminiInteractionsRequest | ❌ No | **BROKEN** | Always calls response.json() |

## Detailed Analysis

### 1. handleClaudeRequest (Native Claude) ✅

**File:** `src/handlers/claude.ts`

**Streaming Support:** ✅ **WORKING**

**Implementation:**
```typescript
// Pass through to native Claude API
const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
    },
    body: JSON.stringify(requestBody),
});

// Return response as-is (pass-through)
return new Response(response.body, {
    status: response.status,
    headers: response.headers,
});
```

**Analysis:**
- ✅ Passes through `response.body` directly
- ✅ Preserves streaming from upstream
- ✅ No JSON parsing that would break streaming
- ✅ Headers passed through (including SSE headers)

**Verdict:** Fully supports SSE streaming from native Claude upstream

---

### 2. handleMessagesRequest (OpenAI-Compatible) ✅

**File:** `src/handlers/messages.ts`

**Streaming Support:** ✅ **WORKING**

**Implementation:**
```typescript
// Check if streaming is requested
const isStreaming = claudeRequest.stream === true;

const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
    },
    body: JSON.stringify(openaiRequest),
});

// Handle streaming response
if (isStreaming) {
    return handleStreamingResponse(response, targetModelId, requestId, activeLogger);
}

// Handle non-streaming response
return handleNonStreamingResponse(response, targetModelId, requestId, activeLogger);
```

**Analysis:**
- ✅ Detects `stream: true` in request
- ✅ Routes to `handleStreamingResponse` for streaming
- ✅ Transforms OpenAI SSE → Claude SSE
- ✅ Proper SSE headers set

**Verdict:** Fully supports SSE streaming from OpenAI-compatible upstream

---

### 3. handleOpenAIRequest (Interactions/OpenAI) ✅

**File:** `src/handlers/openai.ts`

**Streaming Support:** ✅ **WORKING**

**Implementation:**
```typescript
// Detect streaming
isStreaming = claudeRequest.stream === true;

const response = await fetch(targetUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(openaiRequest),
});

// Handle streaming response
if (isStreaming) {
    return handleOpenAIStreamingResponse(response, openaiRequest.model as string, requestId, activeLogger, isInteractionsRequest);
}

// Handle non-streaming response
return handleOpenAINonStreamingResponse(response, openaiRequest.model as string, requestId, activeLogger, isInteractionsRequest);
```

**Analysis:**
- ✅ Detects `stream: true` in request
- ✅ Routes to `handleOpenAIStreamingResponse` for streaming
- ✅ Transforms OpenAI SSE → Claude/Interactions format
- ✅ Proper SSE headers set

**Verdict:** Fully supports SSE streaming from OpenAI-compatible upstream

---

### 4. handleGeminiGenerateContentRequest (Native Gemini) ✅

**File:** `src/handlers/gemini.ts` (lines 462-555)

**Streaming Support:** ✅ **WORKING**

**Implementation:**
```typescript
// Determine if streaming
isStreaming = requestBody.stream === true;

const response = await fetch(fullTargetUrl, {
    method: 'POST',
    headers: geminiHeaders,
    body: JSON.stringify(geminiRequest),
});

// Handle streaming response
if (isStreaming) {
    return handleGeminiStreamingResponse(response, effectiveModelId || 'gemini-pro', requestId, activeLogger, 'interactions');
}

// Handle non-streaming response
return handleGeminiNonStreamingResponse(response, effectiveModelId || 'gemini-pro', requestId, activeLogger, 'interactions');
```

**Analysis:**
- ✅ Detects `stream: true` in request
- ✅ Routes to `handleGeminiStreamingResponse` for streaming
- ✅ Transforms Gemini SSE → Claude format
- ✅ Proper SSE headers set

**Verdict:** Fully supports SSE streaming from native Gemini upstream

---

### 5. handleGeminiInteractionsRequest (Native Gemini) ❌

**File:** `src/handlers/gemini.ts` (lines 90-225)

**Streaming Support:** ❌ **BROKEN**

**Implementation:**
```typescript
// Forward request to Gemini API
const response = await fetch(targetUrl, {
    method: 'POST',
    headers: geminiHeaders,
    body: JSON.stringify(geminiRequest),
});

if (!response.ok) {
    const errorText = await response.text();
    activeLogger.error(requestId, `Gemini API error: ${errorText}`);
    handleTargetApiError(response, 'Gemini API');
}

// ❌ PROBLEM: Always calls response.json() - breaks streaming!
const geminiResponse = await response.json() as any;

const interactionResponse = {
    id: `v1_${Date.now()}_${requestId}`,
    model: requestBody.model || modelId || 'gemini-2.5-flash',
    status: 'completed',
    // ...
};

return new Response(JSON.stringify(interactionResponse), {
    status: 200,
    headers: {
        'Content-Type': 'application/json',
        'x-request-id': requestId,
    },
});
```

**Problems:**
1. ❌ No check for `stream` parameter
2. ❌ Always calls `response.json()` - waits for full response
3. ❌ Returns single JSON response, not SSE stream
4. ❌ No streaming handler called

**Impact:**
- Streaming requests to `/v1/interactions` with native Gemini upstream will NOT stream
- Response will be buffered until complete
- Client will not receive incremental updates

**Verdict:** Does NOT support SSE streaming from native Gemini upstream

---

## Summary Table

| Handler | Endpoint | Mode | Streaming | Status |
|---------|----------|------|-----------|--------|
| handleClaudeRequest | /v1/messages | Native Claude | ✅ Yes | Working |
| handleMessagesRequest | /v1/messages | OpenAI | ✅ Yes | Working |
| handleOpenAIRequest | /v1/interactions | OpenAI | ✅ Yes | Working |
| handleGeminiGenerateContentRequest | /v1beta/models/*:generateContent | Native Gemini | ✅ Yes | Working |
| handleGeminiInteractionsRequest | /v1/interactions | Native Gemini | ❌ No | **BROKEN** |

## Test Coverage

### Working Endpoints (4/5)

**Tested in:** `tests/test_sse_streaming.sh`

1. ✅ `/v1/messages` with OpenAI upstream - Working
2. ✅ `/v1/interactions` with OpenAI upstream - Working
3. ✅ `/v1beta/models/*:generateContent` with OpenAI upstream - Working

**Not tested:**
- Native Claude upstream streaming (pass-through should work)
- Native Gemini upstream streaming (generateContent should work)

### Broken Endpoint (1/5)

❌ `/v1/interactions` with **native Gemini upstream** - Not working

**Reason:** Handler doesn't check for streaming, always buffers full response

## Recommendation

### Fix Required: handleGeminiInteractionsRequest

**Current behavior:**
- Always buffers full response
- No streaming support

**Required changes:**

1. **Check for stream parameter:**
```typescript
const isStreaming = requestBody.stream === true;
```

2. **Add streaming detection in geminiRequest:**
```typescript
if (requestBody.stream) {
    geminiRequest.stream = true;
}
```

3. **Route to streaming handler:**
```typescript
if (isStreaming) {
    return handleGeminiStreamingResponse(response, modelId || 'gemini-2.5-flash', requestId, activeLogger, 'interactions');
}
```

4. **Keep non-streaming path for non-streaming requests**

### Priority

**Medium Priority:**
- Native Gemini Interactions endpoint is less commonly used
- Most users use OpenAI-compatible mode (which works)
- Native Gemini generateContent endpoint works correctly

**Impact:**
- Only affects users using native Gemini mode with /v1/interactions endpoint
- Workaround: Use /v1beta/models/*:generateContent instead

## Conclusion

**4 out of 5 upstream handlers support SSE streaming correctly** ✅

**1 handler needs fixing:**
- `handleGeminiInteractionsRequest` - No streaming support for native Gemini upstream

**Workarounds available:**
- Use OpenAI-compatible mode (works with streaming)
- Use /v1beta/models/*:generateContent endpoint (works with streaming)

## Related Documentation

- `../guides/sse_streaming_review.md` - Client-side SSE support review
- `tests/test_sse_streaming.sh` - SSE streaming tests
