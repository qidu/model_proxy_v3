# Fix: /v1/interactions Streaming for Native Gemini Mode

## Date: 2026-02-26

## Problem

`/v1/interactions` with `stream: true` was failing in native Gemini mode (0% success rate).

**Error:** No SSE response

**Root cause:** Native mode was always routing `/v1/interactions` to `:generateContent`, even when streaming was requested.

---

## Solution

### Dynamic Routing Based on Stream Parameter

For native Gemini mode, check the `stream` parameter in the request body and route accordingly:

**Non-streaming (`stream: false` or omitted):**
```
/v1/interactions → /v1beta/models/{model}:generateContent
```

**Streaming (`stream: true`):**
```
/v1/interactions → /v1beta/models/{model}:streamGenerateContent?alt=sse
```

---

## Code Changes

### src/index.ts - Line ~386

**Before:**
```typescript
} else if (path === '/v1/interactions' || path.startsWith('/v1/interactions?')) {
  handlerType = 'interactions';
  if (modelRoute.mode === 'native') {
    // Native Gemini API - route to generateContent endpoint
    // Use upstream model name (with alias if configured)
    targetUrl = `${modelRoute.targetUrl}/v1beta/models/${upstreamModelName}:generateContent`;
    upstreamMode = 'native';
  } else {
    // OpenAI-compatible mode
    targetUrl = `${modelRoute.targetUrl}/v1/chat/completions`;
    upstreamMode = 'openai-completions';
  }
}
```

**After:**
```typescript
} else if (path === '/v1/interactions' || path.startsWith('/v1/interactions?')) {
  handlerType = 'interactions';
  if (modelRoute.mode === 'native') {
    // Native Gemini API - check if streaming is requested
    const requestBody = JSON.parse(bodyText) as Record<string, unknown>;
    const isStreaming = requestBody.stream === true;
    
    // Route to appropriate endpoint based on streaming
    if (isStreaming) {
      targetUrl = `${modelRoute.targetUrl}/v1beta/models/${upstreamModelName}:streamGenerateContent?alt=sse`;
    } else {
      targetUrl = `${modelRoute.targetUrl}/v1beta/models/${upstreamModelName}:generateContent`;
    }
    upstreamMode = 'native';
  } else {
    // OpenAI-compatible mode
    targetUrl = `${modelRoute.targetUrl}/v1/chat/completions`;
    upstreamMode = 'openai-completions';
  }
}
```

---

## Test Results

### Before Fix

**Native Gemini Mode:**
- ✅ /v1/interactions (non-stream)
- ❌ /v1/interactions (stream) - No SSE
- Success rate: 5/6 (83%)

### After Fix

**Native Gemini Mode:**
- ✅ /v1/interactions (non-stream)
- ✅ /v1/interactions (stream) - SSE works!
- Success rate: 6/6 (100%)

**OpenAI-Compatible Mode:**
- ✅ /v1/interactions (non-stream)
- ✅ /v1/interactions (stream) - Already working
- Success rate: 6/6 (100%)

---

## Comparison: Before vs After

### Native Gemini Mode

| Endpoint | Before | After |
|----------|--------|-------|
| /v1/messages | ✅ | ✅ |
| /v1/messages (stream) | ✅ | ✅ |
| /v1/interactions | ✅ | ✅ |
| /v1/interactions (stream) | ❌ | ✅ |
| generateContent | ✅ | ✅ |
| streamGenerateContent | ✅ | ✅ |

**Success rate:** 83% → 100% ✅

---

## Routing Flow

### Native Gemini Mode - /v1/interactions

**Client Request:**
```json
POST /v1/interactions
{
  "model": "gemini-2.5-flash",
  "input": {
    "messages": [{"role": "user", "content": "Count 1 to 3"}]
  },
  "stream": true
}
```

**Proxy Routing:**
1. Parse request body
2. Check `stream: true`
3. Route to: `https://api.example1.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`
4. Use `handleGeminiRequest` handler
5. Convert Interactions request → Gemini request
6. Return Gemini SSE response

**Upstream Request:**
```
POST https://api.example1.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse
{
  "contents": [{"role": "user", "parts": [{"text": "Count 1 to 3"}]}]
}
```

**Response:**
```
data: {"candidates": [{"content": {"parts": [{"text": "1, 2, 3"}]}}]}
```

---

## Pattern: Consistent Streaming Detection

This fix follows the same pattern as `/v1/messages` streaming fix:

### /v1/messages (already fixed)
```typescript
const requestBody = JSON.parse(bodyText) as Record<string, unknown>;
const isStreaming = requestBody.stream === true;

if (isStreaming) {
  targetUrl = `${modelRoute.targetUrl}/v1beta/models/${upstreamModelName}:streamGenerateContent?alt=sse`;
} else {
  targetUrl = `${modelRoute.targetUrl}/v1beta/models/${upstreamModelName}:generateContent`;
}
```

### /v1/interactions (now fixed)
```typescript
const requestBody = JSON.parse(bodyText) as Record<string, unknown>;
const isStreaming = requestBody.stream === true;

if (isStreaming) {
  targetUrl = `${modelRoute.targetUrl}/v1beta/models/${upstreamModelName}:streamGenerateContent?alt=sse`;
} else {
  targetUrl = `${modelRoute.targetUrl}/v1beta/models/${upstreamModelName}:generateContent`;
}
```

**Same logic, consistent behavior!**

---

## Key Insights

### 1. Native Mode Requires Endpoint Mapping

Native mode assumes the upstream has the same endpoint structure. For Gemini:
- ✅ Claude: Has `/v1/interactions` endpoint
- ❌ Gemini: No `/v1/interactions` endpoint
- ✅ Solution: Map to `:generateContent` or `:streamGenerateContent`

### 2. Stream Parameter Detection

The proxy must inspect the request body to determine routing:
- Parse `bodyText` before routing
- Check `stream` parameter
- Route to appropriate endpoint

### 3. Handler Selection

Handler already correct:
- `/v1/interactions` + native mode → `handleGeminiRequest`
- Automatically handles both `:generateContent` and `:streamGenerateContent`

---

## All Endpoints Now Work

### Native Gemini Mode - 100% Success

**Non-streaming:**
- ✅ /v1/messages
- ✅ /v1/interactions
- ✅ generateContent

**Streaming:**
- ✅ /v1/messages (stream)
- ✅ /v1/interactions (stream)
- ✅ streamGenerateContent

**Score:** 6/6 (100%) ✅

---

### OpenAI-Compatible Mode - 100% Success

**Non-streaming:**
- ✅ /v1/messages
- ✅ /v1/interactions
- ✅ generateContent

**Streaming:**
- ✅ /v1/messages (stream)
- ✅ /v1/interactions (stream)
- ✅ streamGenerateContent

**Score:** 6/6 (100%) ✅

---

## Documentation

- `tests/test_gemini_both_modes.sh` - Test script
- `gemini_interactions_streaming_fix.md` - This file
- `../../tests/logs/results/gemini_both_modes_test_results.md` - Updated test results

---

## Conclusion

✅ **Fixed:** `/v1/interactions` streaming now works in native Gemini mode (100% success rate)

**Implementation:**
- Dynamic routing based on `stream` parameter
- Consistent with `/v1/messages` streaming fix
- Maintains backward compatibility

**Impact:**
- Native Gemini mode: 83% → 100% success rate
- All endpoints: 100% success (both modes)
- No limitations remaining!

**Status:** Native Gemini mode now achieves perfect 100% success rate across all 6 tests! 🎉
