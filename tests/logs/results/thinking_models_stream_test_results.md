# Thinking Models Stream & Non-Stream Test Results

## Date: 2026-02-26
## Test: 9 thinking models × 6 tests = 54 total tests

---

## Summary

**Total:** 34 passed, 20 failed  
**Success Rate:** 62%

**By Test Type:**
- Non-streaming: 27/27 (100%) ✅
- Streaming: 7/27 (26%) ⚠️

---

## Detailed Results

### 1. deepseek/deepseek-v3.2-exp-thinking

**Non-streaming:**
- ✅ /v1/messages
- ✅ /v1/interactions
- ✅ generateContent

**Streaming:**
- ❌ /v1/messages (stream)
- ✅ /v1/interactions (stream)
- ✅ streamGenerateContent

**Score:** 5/6 (83%)

---

### 2. qwen3-vl-30b-a3b-thinking

**Non-streaming:**
- ✅ /v1/messages
- ✅ /v1/interactions
- ✅ generateContent

**Streaming:**
- ❌ /v1/messages (stream)
- ❌ /v1/interactions (stream)
- ❌ streamGenerateContent

**Score:** 3/6 (50%)

---

### 3. qwen3-30b-a3b-thinking-2507

**Non-streaming:**
- ✅ /v1/messages
- ✅ /v1/interactions
- ✅ generateContent

**Streaming:**
- ❌ /v1/messages (stream)
- ❌ /v1/interactions (stream)
- ❌ streamGenerateContent

**Score:** 3/6 (50%)

---

### 4. qwen3-next-80b-a3b-thinking

**Non-streaming:**
- ✅ /v1/messages
- ✅ /v1/interactions
- ✅ generateContent

**Streaming:**
- ❌ /v1/messages (stream)
- ✅ /v1/interactions (stream)
- ✅ streamGenerateContent

**Score:** 5/6 (83%)

---

### 5. qwen3-235b-a22b-thinking-2507

**Non-streaming:**
- ✅ /v1/messages
- ✅ /v1/interactions
- ✅ generateContent

**Streaming:**
- ❌ /v1/messages (stream)
- ❌ /v1/interactions (stream)
- ❌ streamGenerateContent

**Score:** 3/6 (50%)

---

### 6. doubao-seed-1.6-thinking

**Non-streaming:**
- ✅ /v1/messages
- ✅ /v1/interactions
- ✅ generateContent

**Streaming:**
- ❌ /v1/messages (stream)
- ❌ /v1/interactions (stream)
- ✅ streamGenerateContent

**Score:** 4/6 (67%)

---

### 7. doubao-1.5-thinking-pro

**Non-streaming:**
- ✅ /v1/messages
- ✅ /v1/interactions
- ✅ generateContent

**Streaming:**
- ❌ /v1/messages (stream)
- ❌ /v1/interactions (stream)
- ❌ streamGenerateContent

**Score:** 3/6 (50%)

---

### 8. deepseek/deepseek-v3.1-terminus-thinking

**Non-streaming:**
- ✅ /v1/messages
- ✅ /v1/interactions
- ✅ generateContent

**Streaming:**
- ❌ /v1/messages (stream)
- ✅ /v1/interactions (stream)
- ✅ streamGenerateContent

**Score:** 5/6 (83%)

---

### 9. moonshotai/kimi-k2-thinking

**Non-streaming:**
- ✅ /v1/messages
- ✅ /v1/interactions
- ✅ generateContent

**Streaming:**
- ❌ /v1/messages (stream)
- ❌ /v1/interactions (stream)
- ❌ streamGenerateContent

**Score:** 3/6 (50%)

---

## Analysis

### ✅ Working (100%)

**All non-streaming endpoints:**
- /v1/messages (9/9)
- /v1/interactions (9/9)
- generateContent (9/9)

### ⚠️ Partial (26%)

**Streaming endpoints:**
- /v1/messages + stream: 0/9 (0%) ❌
- /v1/interactions + stream: 3/9 (33%)
- streamGenerateContent: 4/9 (44%)

---

## Streaming Success by Model

**High success (83%):**
- deepseek/deepseek-v3.2-exp-thinking: 2/3
- qwen3-next-80b-a3b-thinking: 2/3
- deepseek/deepseek-v3.1-terminus-thinking: 2/3

**Medium success (67%):**
- doubao-seed-1.6-thinking: 1/3

**Low success (50%):**
- qwen3-vl-30b-a3b-thinking: 0/3
- qwen3-30b-a3b-thinking-2507: 0/3
- qwen3-235b-a22b-thinking-2507: 0/3
- doubao-1.5-thinking-pro: 0/3
- moonshotai/kimi-k2-thinking: 0/3

---

## Issues Identified

### 1. /v1/messages streaming fails for all models

**Possible causes:**
- Timeout too short (3 seconds)
- Response format not detected as SSE
- Upstream doesn't support streaming for these models
- Handler issue with messages endpoint

### 2. Some models don't support streaming at all

**Models with 0% streaming success:**
- qwen3-vl-30b-a3b-thinking
- qwen3-30b-a3b-thinking-2507
- qwen3-235b-a22b-thinking-2507
- doubao-1.5-thinking-pro
- moonshotai/kimi-k2-thinking

**Likely cause:** Upstream doesn't support streaming for these specific models

---

## Recommendations

### 1. Investigate /v1/messages streaming

Check why all models fail on `/v1/messages` with `stream: true`:
- Increase timeout
- Check response format
- Verify handler logic

### 2. Document model streaming support

Create a compatibility matrix showing which models support streaming on which endpoints.

### 3. Add fallback behavior

For models that don't support streaming, automatically fall back to non-streaming mode.

---

## Test Configuration

**Upstream:** OpenAI-compatible (https://api.qnaigc.com)  
**Mode:** openai-completions  
**Timeout:** 3 seconds for streaming tests

---

## Files

- `tests/test_thinking_models_stream.sh` - Test script
- `docs/thinking_models_stream_test_results.md` - This file
