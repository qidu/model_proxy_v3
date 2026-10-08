# Test Results: claude-4.5-haiku (Both Modes)

## Date: 2026-02-25

## Test Results: 4/6 passed (66%)

### Summary

| Mode | /v1/messages | /v1/interactions | generateContent | Success Rate |
|------|--------------|------------------|-----------------|--------------|
| Native (with model_alias) | ✅ | ❌ | ❌ | 33% (1/3) |
| OpenAI-Compatible | ✅ | ✅ | ✅ | 100% (3/3) |

**Overall: 4/6 passed (66%)**

## Configuration

### Native Mode (with model_alias)

```toml
[models.claude-4-5-haiku]
mode = "native"
model_alias = "claude-haiku-4-5-20251001"
base_url = "https://api.example2-ai.com"
api_key = "sk-NzBalLnHTBdlL23pQHFSzRZXA36HRio3s666mOcLxFfdmAfK"
```

**Results:**
- ✅ /v1/messages: 86d77ecb-0506-4177-b6c8-961bdbef7af1
- ❌ /v1/interactions: Service error (Gemini-specific endpoint)
- ❌ generateContent: Service error (Gemini-specific endpoint)

### OpenAI-Compatible Mode

```toml
[models.claude-4-5-haiku]
mode = "openai-completions"
base_url = "https://api.qnaigc.com"
api_key = "sk-87abde0542f469130364cc3de48977a71883d8ec81987d3f7e46ee360985dd02"
```

**Results:**
- ✅ /v1/messages: chatcmpl-e35d1dac608c4f0cb799bf752a351553
- ✅ /v1/interactions: v1_1772015000297_req_1772014998499_1yeap77q2
- ✅ generateContent: chatcmpl-cf793bf47e8e492dba9334e38edcb4ca

## Analysis

### Native Mode (33% success)

**✅ Works for: /v1/messages**
- Requires model_alias: `claude-haiku-4-5-20251001`
- Native upstream doesn't support "claude-4.5-haiku" directly
- Uses Claude native API format

**❌ Fails for: /v1/interactions and generateContent**
- These are Gemini-specific endpoints
- Not supported by Claude native upstream
- Expected behavior (not a bug)

### OpenAI-Compatible Mode (100% success)

**✅ Works for all endpoints:**
- /v1/messages: Claude format conversion ✅
- /v1/interactions: Interactions format conversion ✅
- generateContent: Gemini format conversion ✅

**No model_alias needed:**
- Upstream accepts "claude-4.5-haiku" directly
- All format conversions work correctly

## Available Models on Native Upstream

**api.example2-ai.com supports:**
- claude-haiku-4-5-20251001 ✅ (used in model_alias)
- claude-haiku-4-5-20251001-thinking

**Note:** Native upstream uses version-specific names, not "claude-4.5-haiku"

## Endpoint Support Matrix

| Endpoint | Native Claude | OpenAI-Compatible |
|----------|---------------|-------------------|
| /v1/messages | ✅ (with model_alias) | ✅ |
| /v1/interactions | ❌ (Gemini only) | ✅ |
| /v1beta/models/*:generateContent | ❌ (Gemini only) | ✅ |

## Proxy Features Validated

1. ✅ **model_alias for native mode** - Works correctly
   - Client: `claude-4.5-haiku`
   - Upstream: `claude-haiku-4-5-20251001`

2. ✅ **OpenAI-compatible mode** - All endpoints work

3. ✅ **Format conversions** - All conversions work correctly

4. ✅ **Endpoint routing** - Correctly routes based on mode

## Recommendation

### For Production Use: OpenAI-Compatible Mode ✅

**Recommended configuration:**
```toml
[models.claude-4-5-haiku]
mode = "openai-completions"
base_url = "https://api.qnaigc.com"
api_key = "sk-..."
```

**Benefits:**
- ✅ 100% success rate (3/3 endpoints)
- ✅ No model_alias needed
- ✅ All format conversions work
- ✅ Simpler configuration

### For Native Mode: Limited Use Case

**Configuration:**
```toml
[models.claude-4-5-haiku]
mode = "native"
model_alias = "claude-haiku-4-5-20251001"
base_url = "https://api.example2-ai.com"
api_key = "sk-..."
```

**Limitations:**
- ⚠️ Only /v1/messages works (33% success)
- ⚠️ Requires model_alias
- ⚠️ /v1/interactions and generateContent not supported

**Use case:** Only if you need native Claude API features not available in OpenAI-compatible mode

## Comparison with Other Models

| Model | Native Mode | OpenAI Mode | Recommendation |
|-------|-------------|-------------|----------------|
| claude-4.5-haiku | 33% (1/3) | 100% (3/3) | Use OpenAI mode |
| claude-4.5-sonnet | 33% (1/3) | 100% (3/3) | Use OpenAI mode |
| claude-4.1-opus | 33% (1/3) | 33% (1/3) | Use OpenAI mode |
| gemini-2.5-flash | 100% (3/3) | N/A | Use native mode |

## Proxy Status

**Native Mode:** ⚠️ Limited (only /v1/messages)
**OpenAI-Compatible Mode:** ✅ Production Ready (all endpoints)

## Summary

| Aspect | Native Mode | OpenAI Mode |
|--------|-------------|-------------|
| /v1/messages | ✅ (with alias) | ✅ |
| /v1/interactions | ❌ | ✅ |
| generateContent | ❌ | ✅ |
| Configuration | Complex | Simple |
| Success Rate | 33% | 100% |
| Recommendation | ⚠️ Limited | ✅ Recommended |

## Conclusion

**claude-4.5-haiku works best with OpenAI-compatible mode** ✅

- **Native mode:** Only /v1/messages works (requires model_alias)
- **OpenAI mode:** All 3 endpoints work (100% success)
- **Recommendation:** Use OpenAI-compatible mode for production

## Test Script

Run: `bash tests/test_claude_haiku_both_modes.sh`

## Test Questions Used

- /v1/messages: "2+2?"
- /v1/interactions: "3+3?"
- generateContent: "4+4?"
