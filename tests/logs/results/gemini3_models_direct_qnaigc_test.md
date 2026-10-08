# Gemini 3.x Models Direct Upstream Test - qnaigc

## Date: 2026-02-26
## Models: gemini-3.1-pro-preview, gemini-3.0-flash-preview
## Upstream: https://api.qnaigc.com (OpenAI-compatible)
## Config: proxy_config.toml_oversea

---

## Summary

**Direct Upstream Test:** 4/4 (100%) ✅
**Through Proxy:** 0/4 (0%) ❌

**Root Cause:** Configuration issue - proxy needs investigation

---

## Direct Upstream Test Results

### Testing directly at https://api.qnaigc.com/v1/chat/completions

**gemini-3.1-pro-preview:**
- ✅ Non-stream - Works perfectly
- ✅ Stream - Works perfectly

**gemini-3.0-flash-preview:**
- ✅ Non-stream - Works perfectly
- ✅ Stream - Works perfectly

**Request format:**
```bash
POST https://api.qnaigc.com/v1/chat/completions
Authorization: Bearer sk-28f417e15b4643913bce23520d5948327c======
{
  "model": "gemini-3.1-pro-preview",
  "messages": [{"role": "user", "content": "Hi"}],
  "max_tokens": 50
}
```

**Response (gemini-3.1-pro-preview):**
```json
{
  "id": "chatcmpl-511f8c570c32417094c14580233e2c72",
  "object": "chat.completion",
  "created": 1772107424,
  "model": "gemini-3.1-pro-preview",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello",
      "reasoning_content": "**Greeting Consideration**..."
    },
    "finish_reason": "length"
  }],
  "usage": {
    "prompt_tokens": 1,
    "completion_tokens": 46,
    "total_tokens": 47
  }
}
```

---

## Through Proxy Test Results

**Both models:**
- ❌ Non-stream - Target API returned error: 404
- ❌ Stream - Target API returned error: 404

**Config used:**
```toml
[upstream]
default_url = "https://api.qnaigc.com"
default_api_key = "sk-28f417e15b4643913bce23520d5948327c======"

[defaults]
mode = "openai-completions"

[models.gemini-3-1-pro-preview]
mode = "openai-completions"

[models.gemini-3-0-flash-preview]
mode = "openai-completions"
```

---

## Analysis

### Direct Test: ✅ Both Models Work

**qnaigc upstream supports both Gemini 3.x preview models:**
- gemini-3.1-pro-preview: 100%
- gemini-3.0-flash-preview: 100%
- Both streaming and non-streaming work
- Returns OpenAI-compatible format

---

### Proxy Test: ❌ Both Models Fail

**Possible issues:**
1. URL construction problem
2. Request format conversion issue
3. Header forwarding problem
4. Model name normalization issue

**Expected proxy behavior:**
- Client calls: `POST /v1/messages` with Claude format
- Proxy converts to OpenAI format
- Proxy calls: `POST https://api.qnaigc.com/v1/chat/completions`
- Proxy converts response back to Claude format

---

## Key Findings

### 1. Models Are Available ✅

**Both Gemini 3.x preview models work on qnaigc upstream:**
- gemini-3.1-pro-preview ✅
- gemini-3.0-flash-preview ✅

**Previous assumption was wrong:**
- We thought models were not available
- Actually, models ARE available
- Issue is with proxy configuration/routing

---

### 2. Upstream Format

**qnaigc uses standard OpenAI format:**
- Endpoint: `/v1/chat/completions`
- Request: OpenAI chat completions format
- Response: OpenAI chat completions format
- Includes `reasoning_content` for thinking models

---

### 3. Proxy Issue

**Proxy fails to route correctly:**
- Returns 404 error
- Should call `/v1/chat/completions`
- Config appears correct
- Needs debugging

---

## Comparison: example1 vs qnaigc

### example1 (Claude-compatible)

**gemini-3.1-pro-preview:**
- Direct test: ✅ Works
- Endpoint: `/v1/messages`
- Format: Claude Messages API
- Through proxy: ❌ (routing issue - detects as Gemini native)

---

### qnaigc (OpenAI-compatible)

**gemini-3.1-pro-preview:**
- Direct test: ✅ Works
- Endpoint: `/v1/chat/completions`
- Format: OpenAI Chat Completions
- Through proxy: ❌ (unknown issue)

**gemini-3.0-flash-preview:**
- Direct test: ✅ Works
- Endpoint: `/v1/chat/completions`
- Format: OpenAI Chat Completions
- Through proxy: ❌ (unknown issue)

---

## Recommendations

### 1. Debug Proxy Routing

**Check:**
- Actual URL being called by proxy
- Request headers being sent
- Request body format
- Response from upstream

---

### 2. Verify Config

**Current config:**
```toml
default_url = "https://api.qnaigc.com"  # Without /v1
```

**Proxy should construct:**
```
https://api.qnaigc.com/v1/chat/completions
```

---

### 3. Test with Simple Model

**Try with known working model first:**
```bash
curl -X POST http://localhost:8788/v1/messages \
  -d '{"model":"gemini-2.5-flash","messages":[...]}'
```

If this works, issue is model-specific.
If this fails, issue is proxy-wide.

---

## Conclusion

### Status: ✅ Models Available, ❌ Proxy Issue

**Both Gemini 3.x preview models work perfectly when called directly:**
- gemini-3.1-pro-preview: 100% (direct)
- gemini-3.0-flash-preview: 100% (direct)

**Proxy fails for unknown reason:**
- Returns 404 error
- Config appears correct
- Needs debugging to identify root cause

**Next steps:**
1. Add detailed logging to proxy
2. Compare working vs non-working requests
3. Fix routing/configuration issue
4. Retest through proxy

---

## Files

- `/tmp/test_direct_qnaigc.sh` - Direct test script
- `docs/gemini3_models_direct_qnaigc_test.md` - This file
