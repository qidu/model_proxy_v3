# Thinking Models Test Results - Final

## Date: 2026-02-26
## Test: 9 models × 6 tests = 54 total tests
## Timeout: 10 seconds for streaming

---

## Summary

**Total:** 32 passed, 22 failed  
**Success Rate:** 59%

**By Test Type:**
- Non-streaming (simple questions): 27/27 (100%) ✅
- Streaming (complex question): 5/27 (19%) ⚠️

---

## Test Configuration

**Non-streaming tests:**
- Simple questions: "2+2?", "3+3?", "4+4?"
- Expected: Quick JSON response

**Streaming tests:**
- Complex question: "Explain step by step how to solve this problem: A train travels 120 km in 2 hours, then 180 km in 3 hours. What is the average speed for the entire journey?"
- Timeout: 10 seconds
- Expected: SSE stream with step-by-step reasoning

---

## Detailed Results

### High Success (83% - 5/6)

**qwen3-next-80b-a3b-thinking:**
- ✅ All non-streaming (3/3)
- ✅ /v1/interactions (stream)
- ✅ streamGenerateContent (stream)
- ❌ /v1/messages (stream)

---

### Medium Success (67% - 4/6)

**deepseek/deepseek-v3.2-exp-thinking:**
- ✅ All non-streaming (3/3)
- ✅ /v1/interactions (stream)
- ❌ /v1/messages (stream)
- ❌ streamGenerateContent (stream)

**qwen3-vl-30b-a3b-thinking:**
- ✅ All non-streaming (3/3)
- ✅ /v1/interactions (stream)
- ❌ /v1/messages (stream)
- ❌ streamGenerateContent (stream)

**deepseek/deepseek-v3.1-terminus-thinking:**
- ✅ All non-streaming (3/3)
- ✅ /v1/interactions (stream)
- ❌ /v1/messages (stream)
- ❌ streamGenerateContent (stream)

---

### Low Success (50% - 3/6)

**qwen3-30b-a3b-thinking-2507:**
- ✅ All non-streaming (3/3)
- ❌ All streaming (0/3)

**qwen3-235b-a22b-thinking-2507:**
- ✅ All non-streaming (3/3)
- ❌ All streaming (0/3)

**doubao-seed-1.6-thinking:**
- ✅ All non-streaming (3/3)
- ❌ All streaming (0/3)

**doubao-1.5-thinking-pro:**
- ✅ All non-streaming (3/3)
- ❌ All streaming (0/3)

**moonshotai/kimi-k2-thinking:**
- ✅ All non-streaming (3/3)
- ❌ All streaming (0/3)

---

## Streaming Results by Endpoint

### /v1/messages + stream: 0/9 (0%) ❌

**All models fail** - Possible causes:
- Handler issue with messages endpoint streaming
- Upstream doesn't support streaming for this endpoint
- Response format not detected correctly

### /v1/interactions + stream: 4/9 (44%) ✅

**Working models:**
- deepseek/deepseek-v3.2-exp-thinking
- qwen3-vl-30b-a3b-thinking
- qwen3-next-80b-a3b-thinking
- deepseek/deepseek-v3.1-terminus-thinking

**Not working:**
- qwen3-30b-a3b-thinking-2507
- qwen3-235b-a22b-thinking-2507
- doubao-seed-1.6-thinking
- doubao-1.5-thinking-pro
- moonshotai/kimi-k2-thinking

### streamGenerateContent: 1/9 (11%) ⚠️

**Working models:**
- qwen3-next-80b-a3b-thinking

**Not working:** All others (8/9)

---

## Key Findings

### ✅ Non-Streaming: Perfect (100%)

All 9 models work perfectly with simple questions on all 3 endpoints:
- /v1/messages
- /v1/interactions
- generateContent

### ⚠️ Streaming: Limited (19%)

Only 5 out of 27 streaming tests pass:
- 4 models work on /v1/interactions
- 1 model works on streamGenerateContent
- 0 models work on /v1/messages

### 🔍 Observations

1. **Complex questions require longer timeout**
   - 10 seconds needed vs 5 seconds
   - Thinking models need time to process

2. **/v1/messages streaming completely broken**
   - 0% success rate across all models
   - Needs investigation

3. **Model-specific streaming support**
   - DeepSeek models: Better streaming support
   - Qwen models: Mixed results
   - Doubao/Moonshot: No streaming support

4. **Endpoint-specific behavior**
   - /v1/interactions: Best streaming support (44%)
   - streamGenerateContent: Poor support (11%)
   - /v1/messages: No support (0%)

---

## Recommendations

### 1. Fix /v1/messages Streaming

Investigate why all models fail on `/v1/messages` with `stream: true`:
- Check handler logic
- Verify upstream support
- Test response format detection

### 2. Document Streaming Support

Create compatibility matrix:
```
Model                              | /v1/messages | /v1/interactions | streamGenerateContent
-----------------------------------|--------------|------------------|----------------------
deepseek-v3.2-exp-thinking        | ❌           | ✅               | ❌
qwen3-next-80b-a3b-thinking       | ❌           | ✅               | ✅
...
```

### 3. Increase Default Timeout

For thinking models with complex questions:
- Current: 10 seconds
- Recommended: 15-20 seconds

### 4. Add Fallback Logic

If streaming fails, automatically retry with non-streaming mode.

---

## Test Files

- `tests/test_thinking_models_all.sh` - Updated test script
- `docs/thinking_models_final_test_results.md` - This file

---

## Conclusion

**Non-streaming:** ✅ Production ready (100% success)  
**Streaming:** ⚠️ Limited support (19% success)

**Best practices:**
- Use non-streaming for simple questions
- Use /v1/interactions for streaming (best support)
- Avoid /v1/messages streaming (0% success)
- Allow 10+ seconds timeout for complex questions
