# Anthropic API Protocol Evaluation Report

## Executive Summary

Two API endpoints were evaluated for Anthropic API protocol compliance:
- `https://anthropic.qnaigc.com`
- `https://api.qnaigc.com`

**Recommendation: `https://anthropic.qnaigc.com` better implements the Anthropic API protocol.**

---

## Test Results

### 1. Basic Message Completion (/v1/messages)

#### anthropic.qnaigc.com
```json
{
  "id": "chatcmpl-c5ede61e62b9494d82038e6a5363e91c",
  "type": "message",
  "role": "assistant",
  "model": "moonshotai/kimi-k2.5",
  "content": [{"type": "text", "text": "2 + 2 = **4**"}],
  "stop_reason": "end_turn",
  "usage": {"input_tokens": 17, "output_tokens": 70}
}
```
**Status:** ✅ Returns valid Anthropic-style response

#### api.qnaigc.com
```json
{
  "id": "msg_806cc5957ef847fbbe2925ebc035ff1d",
  "type": "message",
  "role": "assistant",
  "model": "moonshotai/kimi-k2.5",
  "content": [
    {"type": "thinking", "thinking": "...", "signature": "..."},
    {"type": "text", "text": "2 + 2 = **4**"}
  ],
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 17,
    "output_tokens": 70,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 0
  }
}
```
**Status:** ✅ Returns valid Anthropic-style response with extended thinking content

---

### 2. Streaming Support

#### anthropic.qnaigc.com
- **Format:** Server-Sent Events (SSE)
- **Events:** `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`
- **Status:** ✅ Correct Anthropic streaming format with proper event types

#### api.qnaigc.com
- **Format:** Server-Sent Events (SSE)
- **Events:** Same events as above plus includes `thinking` content blocks
- **Status:** ✅ Correct Anthropic streaming format with thinking content support

---

### 3. Error Handling

#### Invalid Model Test

**anthropic.qnaigc.com:**
```json
{
  "type": "invalid_request_error",
  "error": {
    "type": "invalid_request_error",
    "message": "Invalid request to Messages API"
  }
}
```

**api.qnaigc.com:**
```json
{
  "error": {
    "message": "no available channels for model invalid-model-name (request_id: chatcmpl-cb819a64b39b49c9b4118129bd221b57)",
    "type": "invalid_request_error"
  }
}
```

**Assessment:**
- anthropic.qnaigc.com: Uses Anthropic-style error envelope with `type` at top level
- api.qnaigc.com: Uses OpenAI-style error envelope with `error` wrapper

**Winner:** anthropic.qnaigc.com (more Anthropic-compliant error format)

#### Authentication Error Test

**anthropic.qnaigc.com:**
```json
{
  "type": "authentication_error",
  "error": {
    "type": "authentication_error",
    "message": "Authentication failed for Messages API"
  }
}
```

**api.qnaigc.com:**
```json
{
  "error": {
    "message": "invalid api key (request_id: chatcmpl-d3b3a42c4862432a9c668352ff82a2eb)",
    "type": "authentication_error"
  }
}
```

**Assessment:** Same pattern - anthropic.qnaigc.com uses Anthropic-style errors, api.qnaigc.com uses OpenAI-style.

---

### 4. Models Endpoint (/v1/models)

#### anthropic.qnaigc.com
```json
{
  "data": [
    {
      "id": "minimax/minimax-m2.5",
      "type": "model",
      "created_at": "2026-02-12T09:00:40.000Z",
      "display_name": "minimax/minimax-m2.5"
    }
  ],
  "first_id": "minimax/minimax-m2.5",
  "has_more": false,
  "last_id": "qwen3-next-80b-a3b-instruct"
}
```

#### api.qnaigc.com
```json
{
  "object": "list",
  "data": [
    {
      "id": "minimax/minimax-m2.5",
      "object": "model",
      "created": 1770886840,
      "owned_by": "system"
    }
  ]
}
```

**Assessment:**
- anthropic.qnaigc.com: Uses Anthropic-style model format (`type`, `created_at`, `display_name`, pagination with `first_id`/`last_id`)
- api.qnaigc.com: Uses OpenAI-style model format (`object`, `created`, `owned_by`)

**Winner:** anthropic.qnaigc.com (matches Anthropic API spec)

---

### 5. Advanced Features Test (System Prompt + Multi-turn)

Both endpoints correctly:
- Accept `system` parameter
- Handle multi-turn conversation history
- Return appropriate responses

**anthropic.qnaigc.com:** Returns concise response following system instruction
**api.qnaigc.com:** Returns thinking content + response

---

## Protocol Compliance Comparison

| Feature | anthropic.qnaigc.com | api.qnaigc.com |
|---------|---------------------|----------------|
| Response format | Anthropic-style | Anthropic-style |
| Error format | ✅ Anthropic-style | ❌ OpenAI-style |
| Models endpoint | ✅ Anthropic-style | ❌ OpenAI-style |
| Streaming | ✅ SSE with Anthropic events | ✅ SSE with Anthropic events |
| System prompt | ✅ Supported | ✅ Supported |
| Multi-turn | ✅ Supported | ✅ Supported |
| Thinking content | ⚠️ Basic support | ✅ Extended support |
| Usage tracking | ✅ Basic | ✅ Extended (cache tokens) |

---

## Key Findings

### anthropic.qnaigc.com Strengths:
1. **Error format** strictly follows Anthropic API conventions
2. **Models endpoint** uses Anthropic-style response structure with proper pagination
3. **Consistent envelope format** across all responses
4. Clean, minimal response structure

### api.qnaigc.com Strengths:
1. **Extended thinking content** support with signatures
2. **Cache token tracking** in usage metrics
3. More detailed error messages with request IDs

### api.qnaigc.com Weaknesses:
1. **Error responses** use OpenAI-style format (`{"error": {...}}` instead of Anthropic's `{"type": "...", "error": {...}}`)
2. **Models endpoint** returns OpenAI-style format (`object`, `owned_by` instead of `type`, `display_name`)

---

## Conclusion

**`https://anthropic.qnaigc.com` is the better implementation** of the Anthropic API protocol because:

1. Error responses follow Anthropic's format specification
2. Models endpoint matches Anthropic's structure
3. Overall API envelope consistency aligns with Anthropic conventions

While `api.qnaigc.com` offers richer features (thinking content, cache tracking), its error handling and models endpoint follow OpenAI conventions, making it a hybrid implementation rather than a pure Anthropic API protocol implementation.

For applications expecting strict Anthropic API compatibility, **anthropic.qnaigc.com** is the recommended endpoint.

---

## Test Details

- **API Key Used:** `sk-dacbaffa39360db740a9120cb2ba1590b89c4ffb687eddae43acfdb813e2594d`
- **Model Tested:** `moonshotai/kimi-k2.5`
- **Test Date:** 2026-02-24
- **Tested Endpoints:**
  - POST /v1/messages
  - GET /v1/models
