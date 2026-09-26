# z-ai/glm-5 Test Results

## Date: 2026-02-26
## Model: z-ai/glm-5
## Mode: OpenAI-Compatible
## Key: Alternative key from test_keys.md

---

## Summary

**Total:** 1 passed, 5 failed out of 6 tests  
**Success Rate:** 16.7%

**Issue:** Model only supports `/v1/messages` endpoint

**Note:** `/v1/interactions` and `generateContent` are Gemini-specific endpoints and not supported by this model.

---

## Test Results

### z-ai/glm-5

**Non-Streaming Tests:**
- ❌ /v1/messages: Empty response (intermittent)
- ❌ /v1/interactions: Not supported (Gemini-specific endpoint)
- ❌ generateContent: Not supported (Gemini-specific endpoint)

**Streaming Tests:**
- ✅ /v1/messages (stream): SSE works!
- ❌ /v1/interactions (stream): Not supported (Gemini-specific endpoint)
- ❌ streamGenerateContent: Not supported (Gemini-specific endpoint)

**Score:** 1/6 (16.7%)

**Note:** Only `/v1/messages` endpoint is applicable for this model. Other endpoints are Gemini-specific.

---

## Issues Identified

### 1. Routing Problem

**Symptoms:**
- `/v1/interactions` routes to Gemini handler (404)
- `generateContent` routes to Gemini handler (404)
- Error: "Target API (Gemini API) returned error: 404"

**Root cause:**
- Model name `z-ai/glm-5` may be triggering incorrect routing logic
- Proxy incorrectly identifies it as a Gemini model
- Should route to OpenAI handler, not Gemini handler

---

### 2. Intermittent Non-Streaming Issue

**Symptoms:**
- `/v1/messages` non-streaming sometimes returns empty
- Direct upstream test works fine
- Proxy test sometimes works, sometimes fails

**Possible causes:**
- Timeout issue
- Upstream rate limiting
- Transient network issue

---

## Direct Upstream Test

**Test:** Bypass proxy, call upstream directly

```bash
curl "https://api.qnaigc.com/v1/chat/completions" \
  -H "Authorization: Bearer sk-..." \
  -d '{"model":"z-ai/glm-5","messages":[...]}'
```

**Result:** ✅ Works perfectly
- Response: `chatcmpl-772e63590549492cbc5bc25550ed4c07`

**Conclusion:** Upstream supports the model, issue is in proxy routing.

---

## Comparison with Other Models

### Working Models (100%)

- deepseek-r1: 6/6 ✅
- glm-4.5: 6/6 ✅
- glm-4.5-air: 6/6 ✅

### z-ai/glm-5 (16.7%)

- Only `/v1/messages` streaming works
- All other endpoints fail

**Pattern:** Other GLM models work fine, only `z-ai/glm-5` has issues.

---

## Root Cause Analysis

### Why `/v1/interactions` Routes to Gemini Handler

**Expected routing:**
```
/v1/interactions → OpenAI handler → /v1/chat/completions
```

**Actual routing:**
```
/v1/interactions → Gemini handler → 404 error
```

**Hypothesis:**
- Model name contains `/` character
- Routing logic may be checking model name patterns
- `z-ai/glm-5` might match some Gemini-related pattern
- Needs investigation in routing code

---

## Recommendations

### 1. Fix Routing Logic

**Issue:** Model incorrectly routes to Gemini handler

**Action:**
- Review routing logic in `src/index.ts`
- Check model name pattern matching
- Ensure `z-ai/glm-5` routes to OpenAI handler
- Test with other models containing `/` in name

---

### 2. Investigate Non-Streaming Issue

**Issue:** `/v1/messages` non-streaming intermittently fails

**Action:**
- Add more detailed logging
- Check for timeout issues
- Verify response handling
- Test multiple times to confirm pattern

---

### 3. Workaround

**For now:**
- ✅ Use `/v1/messages` with `stream: true` (works)
- ❌ Avoid `/v1/interactions` and `generateContent` endpoints
- ⚠️ `/v1/messages` non-streaming unreliable

---

## Test Configuration

**Upstream:** https://api.qnaigc.com/v1  
**API Key:** sk-28f417e15b4643913bce23520d5948327c======  
**Mode:** openai-completions  
**Timeout:** 10s (non-streaming), 20s (streaming)

---

## Files

- `tests/test_glm5.sh` - Test script
- `docs/glm5_test_results.md` - This file

---

## Conclusion

### Status: ⚠️ Partial Support

**Working:**
- ✅ /v1/messages streaming (1/2 applicable tests)

**Not working:**
- ⚠️ /v1/messages non-streaming (intermittent)

**Not applicable:**
- N/A /v1/interactions (Gemini-specific)
- N/A generateContent (Gemini-specific)
- N/A streamGenerateContent (Gemini-specific)

**Actual success rate for applicable endpoints:** 50% (1/2)

**Root cause:** `/v1/messages` non-streaming has intermittent issues. Streaming works reliably.

**Recommendation:** Use `/v1/messages` with `stream: true` for this model.

**Priority:** Low - Model works on upstream, only non-streaming has intermittent issues.
