# Native Gemini API Test Results

## Date: 2026-02-26
## Model: gemini-2.5-flash
## Mode: Native Gemini API
## Upstream: https://api.example1.com

---

## Test Results

### Test 1: :generateContent?alt=sse
**Request:**
```bash
POST /v1beta/models/gemini-2.5-flash:generateContent?alt=sse
{"contents": [...]}
```

**Upstream:**
```
POST https://api.example1.com/v1beta/models/gemini-2.5-flash:generateContent?alt=sse
```

**Response:**
```json
{"id":"msg_...","type":"message","role":"assistant","model":"gemini-2.5-flash","content":[{"type":"text","text":"Hi there! How can I help you today?"}],"stop_reason":"end_turn","usage":{"input_tokens":2,"output_tokens":10}}
```

**Result:** ⚠️ Returns Claude format (not SSE) - Upstream returns SSE but proxy converts to Claude JSON

---

### Test 2: :streamGenerateContent  
**Request:**
```bash
POST /v1beta/models/gemini-2.5-flash:streamGenerateContent
{"contents": [...]}
```

**Upstream:**
```
POST https://api.example1.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse
```

**Response:**
```
data: {"candidates": [{"content": {"parts": [{"text": "Hello! How can I help you today?"}],"role": "model"},"finishReason": "STOP","index": 0}],"usageMetadata": {...},"modelVersion": "gemini-2.5-flash","responseId": "..."}
```

**Result:** ✅ PASS - Returns native Gemini SSE format (pass-through)

---

### Test 3: :generateContent with stream: true
**Request:**
```bash
POST /v1beta/models/gemini-2.5-flash:generateContent
{"contents": [...], "stream": true}
```

**Upstream:**
```
POST https://api.example1.com/v1beta/models/gemini-2.5-flash:generateContent
```

**Response:**
```json
{
  "candidates": [
    {
      "content": {...}
    }
  ]
}
```

**Result:** ❌ FAIL - Returns JSON (not streaming) - Upstream doesn't stream without `?alt=sse`

---

## Configuration

**proxy_config.toml:**
```toml
[models.gemini-2-5-flash]
mode = "native"
base_url = "https://api.example1.com"
api_key = "sk-..."
```

---

## Routing Behavior

### Native Mode

| Client Request | Upstream Request | Response Format |
|----------------|------------------|-----------------|
| `:generateContent` + `stream: true` | `:generateContent` | JSON (no SSE) |
| `:generateContent?alt=sse` | `:generateContent?alt=sse` | Claude JSON (converted from SSE) |
| `:streamGenerateContent` | `:streamGenerateContent?alt=sse` | Gemini SSE (pass-through) ✅ |

---

## Key Findings

### ✅ Working
- `:streamGenerateContent` correctly routes to `:streamGenerateContent?alt=sse`
- Native Gemini SSE format passes through correctly
- Proxy detects upstream SSE and handles it properly

### ⚠️ Partial
- `:generateContent?alt=sse` returns Claude format instead of SSE
  - Upstream returns SSE
  - Proxy converts to Claude JSON format
  - This may be intentional behavior

### ❌ Not Working
- `:generateContent` with `stream: true` doesn't stream
  - Native Gemini API requires `?alt=sse` for streaming
  - Just `stream: true` in body is not enough

---

## Code Changes Made

### 1. Fixed endpoint detection (src/handlers/gemini.ts)
```typescript
// Before
const needsEndpoint = !targetUrl.includes(":generateContent");

// After  
const needsEndpoint = !targetUrl.match(/:(?:stream)?[Gg]enerateContent/);
```

### 2. Added upstream streaming detection (src/handlers/gemini.ts)
```typescript
// Check if upstream will return SSE (based on URL)
const upstreamIsStreaming = fullTargetUrl.includes("?alt=sse") || 
                           fullTargetUrl.includes(":streamGenerateContent");
if (upstreamIsStreaming) {
    isStreaming = true;
}
```

---

## Summary

✅ **:streamGenerateContent works correctly with native Gemini API**

**Routing:**
- Client: `/v1beta/models/gemini-2.5-flash:streamGenerateContent`
- Proxy: Adds `?alt=sse` automatically
- Upstream: `/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`
- Response: Native Gemini SSE format (pass-through)

**Status:** Production ready for `:streamGenerateContent` endpoint with native Gemini upstream

---

## Next Steps

### Optional Improvements

1. **Make `:generateContent?alt=sse` return SSE instead of Claude JSON**
   - Currently converts SSE to Claude format
   - Could pass through SSE directly

2. **Add `?alt=sse` when `stream: true` is in request body**
   - Currently `:generateContent` + `stream: true` doesn't stream
   - Could automatically append `?alt=sse` to upstream URL

---

## Files

- `src/handlers/gemini.ts` - Fixed endpoint detection and streaming detection
- `src/index.ts` - Routing logic for streamGenerateContent
- `docs/streamgeneratecontent_native_test_results.md` - This file
