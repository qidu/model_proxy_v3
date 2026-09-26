# gemini-3.1-pro-preview Direct Upstream Test Results

## Date: 2026-02-26
## Model: gemini-3.1-pro-preview
## Upstream: https://api.example1.com
## Config: proxy_config.toml_oversea

---

## Summary

**Direct Upstream Test:** 2/2 (100%) ✅
**Through Proxy:** 0/2 (0%) ❌

**Root Cause:** Upstream API format mismatch

---

## Direct Upstream Test Results

### Testing directly at https://api.example1.com

- ✅ Non-stream - Works perfectly
- ✅ Stream - Works perfectly

**Request format:**
```bash
POST https://api.example1.com/v1/messages
Authorization: Bearer sk-qeFSCTmVW61oSbOTFdrxi******
{
  "model": "gemini-3.1-pro-preview",
  "messages": [{"role": "user", "content": "Hi"}],
  "max_tokens": 50
}
```

**Response:**
```json
{
  "id": "chatcmpl-20260226194426347013523VjvWNvyo",
  "type": "message",
  "role": "assistant",
  "content": [{"type": "text", "text": "Hello!"}],
  "stop_reason": "max_tokens",
  "model": "gemini-3.1-pro-preview",
  "usage": {
    "input_tokens": 2,
    "output_tokens": 46
  }
}
```

---

## Through Proxy Test Results

### Native Mode

- ❌ Non-stream - 404 error
- ❌ Stream - 404 error

**Issue:** Proxy routes to Gemini native API (`/v1beta/models/gemini-3.1-pro-preview:generateContent`) but upstream expects Claude format (`/v1/messages`)

---

### OpenAI-Compatible Mode

- ❌ Non-stream - 404 error
- ❌ Stream - 404 error

**Issue:** Proxy routes to OpenAI format (`/v1/chat/completions`) but upstream expects Claude format (`/v1/messages`)

---

## Root Cause Analysis

### Upstream API Format

**example1 upstream uses Claude API format:**
- Endpoint: `/v1/messages`
- Request format: Claude Messages API
- Response format: Claude Messages API

**NOT OpenAI format:**
- Does NOT support `/v1/chat/completions`
- Does NOT support OpenAI request/response format

**NOT Gemini native format:**
- Does NOT support `/v1beta/models/*:generateContent`
- Does NOT support Gemini native API

---

### Proxy Routing Logic

**Current behavior:**

1. **Native mode + gemini-* model name:**
   - Routes to: `/v1beta/models/{model}:generateContent`
   - Expected by upstream: `/v1/messages`
   - Result: 404 error ❌

2. **OpenAI-compatible mode:**
   - Routes to: `/v1/chat/completions`
   - Expected by upstream: `/v1/messages`
   - Result: 404 error ❌

---

## Solution

### Option 1: Use Claude Native Mode (Recommended)

Since example1 uses Claude API format, configure as Claude native:

```toml
[models.gemini-3-1-pro-preview]
mode = "native"
base_url = "https://api.example1.com"
api_key = "sk-qeFSCTmVW61oSbOTFdrxi******"
```

**But this won't work because:**
- Model name starts with "gemini-"
- Proxy detects it as Gemini model
- Routes to Gemini native API instead of Claude API

---

### Option 2: Use Model Alias

Rename the model to not start with "gemini-":

```toml
[models.example1-gemini-3-1-pro]
mode = "native"
model_alias = "gemini-3.1-pro-preview"
base_url = "https://api.example1.com"
api_key = "sk-qeFSCTmVW61oSbOTFdrxi******"
```

**Usage:**
```bash
curl -X POST http://localhost:8788/v1/messages \
  -d '{"model":"example1-gemini-3-1-pro","messages":[...]}'
```

---

### Option 3: Add New Mode (Code Change Required)

Add "claude-compatible" mode that routes to `/v1/messages` regardless of model name:

```toml
[models.gemini-3-1-pro-preview]
mode = "claude-compatible"  # New mode
base_url = "https://api.example1.com"
api_key = "sk-qeFSCTmVW61oSbOTFdrxi******"
```

---

## Recommendation

### Immediate Solution: Use Model Alias (Option 2)

**Config:**
```toml
[models.example1-gemini31-pro]
mode = "native"
model_alias = "gemini-3.1-pro-preview"
base_url = "https://api.example1.com"
api_key = "sk-qeFSCTmVW61oSbOTFdrxi******"
```

**Usage:**
```json
{
  "model": "example1-gemini31-pro",
  "messages": [{"role": "user", "content": "Hi"}]
}
```

---

### Long-term Solution: Add Claude-Compatible Mode (Option 3)

Modify proxy to support upstreams that use Claude API format but serve non-Claude models.

---

## Key Findings

1. **gemini-3.1-pro-preview works perfectly on example1 upstream** ✅
2. **example1 uses Claude API format, not OpenAI or Gemini native** ✅
3. **Proxy routing logic assumes:**
   - `gemini-*` models → Gemini native API
   - `claude-*` models → Claude native API
   - Other models → OpenAI API
4. **This assumption breaks for Claude-compatible upstreams serving Gemini models** ❌

---

## Conclusion

### Status: ✅ Model Available, ❌ Proxy Routing Issue

**The model works perfectly when called directly.**

**The proxy fails because:**
- Upstream uses Claude API format (`/v1/messages`)
- Proxy routes gemini-* models to Gemini native API
- Proxy routes openai-completions mode to OpenAI API (`/v1/chat/completions`)
- Neither matches the upstream's actual format

**Workaround:** Use model alias to avoid "gemini-" prefix

**Proper fix:** Add support for Claude-compatible upstreams serving non-Claude models

---

## Files

- `tests/test_gemini3_quick.sh` - Test script
- `docs/gemini31_pro_direct_upstream_test.md` - This file
