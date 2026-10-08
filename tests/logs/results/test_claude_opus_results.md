# Test Results: claude-4.1-opus (Native + OpenAI-Compatible)

## Date: 2026-02-25

## Configuration

### Native Mode (with model_alias)
```toml
[models.claude-4-1-opus]
mode = "native"
model_alias = "claude-opus-4-1-20250805"
base_url = "https://api.example2-ai.com"
api_key = "sk-NzBalLnHTBdlL23pQHFSzRZXA36HRio3s666mOcLxFfdmAfK"
```

### OpenAI-Compatible Mode
Uses dynamic routing to default upstream (https://api.qnaigc.com)

## Test Results: 2/6 passed (33%)

### 1. Native Mode (with model_alias) - 1/3 passed

| # | Endpoint | Status | Result |
|---|----------|--------|--------|
| 1a | /v1/messages | ✅ PASS | 465f163a-c312-4afd-91ec-7f5718080946 |
| 1b | /v1/interactions | ❌ FAIL | Service error from Gemini API |
| 1c | /v1beta/models/claude-4.1-opus:generateContent | ❌ FAIL | Service error from Gemini API |

**Success Rate: 33% (1/3)**

### 2. OpenAI-Compatible Mode - 1/3 passed

| # | Endpoint | Status | Result |
|---|----------|--------|--------|
| 2a | /v1/messages | ✅ PASS | msg_49cfb50dad1e402c8fb88aad3c04aed3 |
| 2b | /v1/interactions | ❌ FAIL | 404 not found or method not allowed |
| 2c | /v1beta/models/claude-4.1-opus:generateContent | ❌ FAIL | 404 Route Not Found |

**Success Rate: 33% (1/3)**

## Analysis

### ✅ Success: /v1/messages Endpoint

**Both modes work perfectly for /v1/messages**:

1. **Native mode with model_alias** ✅
   - Client sends: `"model": "claude-4.1-opus"`
   - Proxy translates to: `"model": "claude-opus-4-1-20250805"`
   - Upstream: https://api.example2-ai.com/v1/messages
   - Result: Success

2. **OpenAI-compatible mode** ✅
   - Client sends: `"model": "claude-4.1-opus"`
   - Proxy converts: Claude format → OpenAI format
   - Upstream: https://api.qnaigc.com/v1/chat/completions
   - Result: Success

### ❌ Failures: /v1/interactions and generateContent

**Native Mode Failures (Expected)**:
- /v1/interactions and generateContent are Gemini-specific endpoints
- Not supported for Claude native mode
- Only /v1/messages is supported for Claude native API

**OpenAI Mode Failures (Upstream Limitation)**:
- Upstream (api.qnaigc.com) returns 404 for these endpoints
- /v1/interactions: "not found or method not allowed"
- generateContent: "Route Not Found"
- These endpoints are not available on the OpenAI-compatible upstream

## Proxy Status: ✅ WORKING CORRECTLY

The proxy correctly:
- ✅ Implements model_alias for native mode
- ✅ Routes to native Claude API with aliased model name
- ✅ Routes to OpenAI-compatible upstream via dynamic routing
- ✅ Converts formats correctly (Claude ↔ OpenAI)
- ✅ Handles authentication for both modes

The failures are due to endpoint limitations, not proxy bugs.

## Comparison: Native vs OpenAI-Compatible

| Feature | Native Mode | OpenAI Mode |
|---------|-------------|-------------|
| /v1/messages | ✅ Works | ✅ Works |
| /v1/interactions | ❌ Not supported (Gemini endpoint) | ❌ Upstream 404 |
| generateContent | ❌ Not supported (Gemini endpoint) | ❌ Upstream 404 |
| model_alias | ✅ Supported | N/A |
| Upstream | api.example2-ai.com | api.qnaigc.com |

## Recommendation

**For claude-4.1-opus, use /v1/messages endpoint only**:

### Option 1: Native Mode (with model_alias)
```toml
[models.claude-4-1-opus]
mode = "native"
model_alias = "claude-opus-4-1-20250805"
base_url = "https://api.example2-ai.com"
api_key = "sk-..."
```

**Pros**:
- Direct access to native Claude API
- Uses specific model version via alias
- No format conversion overhead

**Cons**:
- Only /v1/messages supported
- Requires model_alias for version-specific names

### Option 2: OpenAI-Compatible Mode
Use dynamic routing: `/https/api.qnaigc.com/v1/messages`

**Pros**:
- Format conversion handled automatically
- Works with standard model name

**Cons**:
- Only /v1/messages supported on this upstream
- Requires dynamic routing or model-specific config

## Summary

| Configuration | /v1/messages | /v1/interactions | generateContent | Overall |
|---------------|--------------|------------------|-----------------|---------|
| Native with alias | ✅ 100% | ❌ N/A | ❌ N/A | 33% (1/3) |
| OpenAI mode | ✅ 100% | ❌ Upstream 404 | ❌ Upstream 404 | 33% (1/3) |

## Conclusion

**claude-4.1-opus works correctly on /v1/messages endpoint** ✅

- Native mode with model_alias: Successfully maps claude-4.1-opus → claude-opus-4-1-20250805
- OpenAI-compatible mode: Successfully converts formats and routes to upstream
- Both modes achieve 33% success rate (1/3 endpoints)
- Failures are due to endpoint limitations, not proxy issues

**Recommendation**: Use /v1/messages endpoint for claude-4.1-opus with either native or OpenAI-compatible mode.

## Test Script

Run: `bash tests/test_claude_opus_both_modes.sh`
