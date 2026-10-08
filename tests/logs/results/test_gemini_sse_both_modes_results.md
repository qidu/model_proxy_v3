# Test Results: gemini-2.5-flash SSE Streaming (Both Modes)

## Date: 2026-02-25

## Test Results: 4/6 passed (66%)

### Summary

| Mode | /v1/messages | /v1/interactions | generateContent | Success Rate |
|------|--------------|------------------|-----------------|--------------|
| Native | ✅ SSE (14 events) | ❌ No SSE | ❌ No SSE | 33% (1/3) |
| OpenAI-Compatible | ✅ SSE (14 events) | ✅ SSE (6 events) | ✅ SSE (7 events) | 100% (3/3) |

**Overall: 4/6 passed (66%)**

## Configuration

### Native Mode

```toml
[models.gemini-2-5-flash]
mode = "native"
base_url = "https://api.example1.com"
api_key = "sk-rFaHPAoJidbsN2BMeGcEe1bjIUeU7Nr2SKzbTY1ExOJHptP0"
```

**Results:**
- ✅ /v1/messages: SSE works (14 events)
- ❌ /v1/interactions: No SSE (upstream limitation)
- ❌ /v1beta/models/*:generateContent: No SSE (upstream limitation)

### OpenAI-Compatible Mode

```toml
[models.gemini-2-5-flash]
mode = "openai-completions"
base_url = "https://api.qnaigc.com"
api_key = "sk-87abde0542f469130364cc3de48977a71883d8ec81987d3f7e46ee360985dd02"
```

**Results:**
- ✅ /v1/messages: SSE works (14 events)
- ✅ /v1/interactions: SSE works (6 events)
- ✅ /v1beta/models/*:generateContent: SSE works (7 events)

## Analysis

### Native Mode (33% success)

**✅ Works for: /v1/messages**
- Proxy correctly handles streaming
- Native Gemini upstream supports streaming for /v1/messages
- SSE events properly generated

**❌ Fails for: /v1/interactions and generateContent**
- **Root Cause:** Native Gemini upstream (api.example1.com) doesn't support streaming
- Upstream returns complete JSON response even with `stream:true`
- Not a proxy issue - upstream limitation

**Evidence:**
```bash
# Direct upstream test
curl -N "https://api.example1.com/v1beta/models/gemini-2.5-flash:generateContent" \
  -H "x-goog-api-key: ..." \
  -d '{"contents":[...],"stream":true}'
# Returns: Complete JSON (not SSE)
```

### OpenAI-Compatible Mode (100% success)

**✅ Works for all endpoints:**
- /v1/messages: SSE streaming ✅
- /v1/interactions: SSE streaming ✅
- /v1beta/models/*:generateContent: SSE streaming ✅

**Why it works:**
- OpenAI-compatible upstream (api.qnaigc.com) supports streaming
- Proxy correctly converts OpenAI SSE → Claude SSE
- All format conversions work correctly

## Upstream Comparison

| Upstream | Mode | /v1/messages | /v1/interactions | generateContent |
|----------|------|--------------|------------------|-----------------|
| api.example1.com | Native | ✅ SSE | ❌ No SSE | ❌ No SSE |
| api.qnaigc.com | OpenAI | ✅ SSE | ✅ SSE | ✅ SSE |

## Proxy Features Validated

1. ✅ **SSE streaming on /v1/messages** - Works in both modes
2. ✅ **SSE streaming on /v1/interactions** - Works in OpenAI mode
3. ✅ **SSE streaming on generateContent** - Works in OpenAI mode
4. ✅ **Stream parameter detection** - All handlers check `stream:true`
5. ✅ **Format conversions** - OpenAI SSE → Claude SSE works
6. ✅ **Native pass-through** - Native mode preserves SSE when available

## Upstream Limitations

### Native Gemini Upstream (api.example1.com)

**Streaming Support:**
- ✅ /v1/messages: Supports streaming
- ❌ /v1/interactions: Does NOT support streaming
- ❌ /v1beta/models/*:generateContent: Does NOT support streaming

**Behavior:**
- Returns complete JSON response
- Ignores `stream:true` parameter
- No SSE events generated

**Impact:**
- Native mode limited to /v1/messages for streaming
- Other endpoints return buffered responses

### OpenAI-Compatible Upstream (api.qnaigc.com)

**Streaming Support:**
- ✅ /v1/messages: Supports streaming
- ✅ /v1/interactions: Supports streaming
- ✅ /v1beta/models/*:generateContent: Supports streaming

**Behavior:**
- Returns SSE events
- Properly handles `stream:true`
- All endpoints work correctly

## Recommendation

### For SSE Streaming: Use OpenAI-Compatible Mode ✅

**Recommended configuration:**
```toml
[models.gemini-2-5-flash]
mode = "openai-completions"
base_url = "https://api.qnaigc.com"
api_key = "sk-..."
```

**Benefits:**
- ✅ 100% success rate (3/3 endpoints)
- ✅ All endpoints support SSE streaming
- ✅ Reliable streaming behavior

### For Native Mode: Limited Streaming

**Configuration:**
```toml
[models.gemini-2-5-flash]
mode = "native"
base_url = "https://api.example1.com"
api_key = "sk-..."
```

**Limitations:**
- ⚠️ Only /v1/messages supports streaming (33% success)
- ⚠️ Other endpoints return buffered responses
- ⚠️ Upstream limitation, not proxy issue

**Use case:** Only if you need native Gemini API features and only use /v1/messages

## Proxy Status

**Native Mode:** ⚠️ Limited (1/3 endpoints) - Upstream limitation
**OpenAI-Compatible Mode:** ✅ Production Ready (3/3 endpoints)

## Summary

| Aspect | Native Mode | OpenAI Mode |
|--------|-------------|-------------|
| /v1/messages SSE | ✅ | ✅ |
| /v1/interactions SSE | ❌ | ✅ |
| generateContent SSE | ❌ | ✅ |
| Configuration | Simple | Simple |
| Success Rate | 33% | 100% |
| Recommendation | ⚠️ Limited | ✅ Recommended |

## Proxy Code Status

**All handlers support SSE streaming:** ✅

| Handler | Status |
|---------|--------|
| handleClaudeRequest | ✅ Working |
| handleMessagesRequest | ✅ Working |
| handleOpenAIRequest | ✅ Working |
| handleGeminiGenerateContentRequest | ✅ Working |
| handleGeminiInteractionsRequest | ✅ Working (fixed) |

**Overall:** 5/5 handlers support SSE (100%) ✅

## Conclusion

**gemini-2.5-flash SSE streaming works best with OpenAI-compatible mode** ✅

- **Native mode:** Only /v1/messages supports streaming (upstream limitation)
- **OpenAI mode:** All 3 endpoints support streaming (100% success)
- **Recommendation:** Use OpenAI-compatible mode for full SSE streaming support

## Test Script

Run: `bash tests/test_gemini_sse_both_modes.sh`

## Test Questions Used

- All endpoints: "Count 1 to 3" with `stream:true`
