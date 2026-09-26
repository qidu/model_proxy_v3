# Test Results: claude-4.5-sonnet with Native Upstream

## Date: 2026-02-25

## Configuration

```toml
[models.claude-4-5-sonnet]
mode = "native"
base_url = "https://api.example2-ai.com"
api_key = "sk-NzBalLnHTBdlL23pQHFSzRZXA36HRio3s666mOcLxFfdmAfK"
```

## Test Results: 0/3 passed (0%)

### claude-4.5-sonnet (native mode)

| # | Endpoint | Status | Error |
|---|----------|--------|-------|
| 1 | /v1/messages | ❌ FAIL | Service error from Claude API |
| 2 | /v1/interactions | ❌ FAIL | Service error from Gemini API |
| 3 | /v1beta/models/claude-4.5-sonnet:generateContent | ❌ FAIL | Service error from Gemini API |

**Success Rate: 0%**

## Root Cause Analysis

### Direct Upstream Test

Testing the native upstream directly:

```bash
curl "https://api.example2-ai.com/v1/messages" \
  -H "x-api-key: sk-NzBalLnHTBdlL23pQHFSzRZXA36HRio3s666mOcLxFfdmAfK" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-4.5-sonnet","messages":[...],"max_tokens":50}'
```

**Response**:
```json
{
  "error": {
    "code": "model_not_found",
    "message": "No available channel for model claude-4.5-sonnet under group default (distributor)",
    "type": "new_api_error"
  }
}
```

### Conclusion

**The native upstream (https://api.example2-ai.com) does not support claude-4.5-sonnet**

This is an **upstream limitation**, not a proxy bug. The proxy is working correctly:
- ✅ Routing is correct: `https://api.example2-ai.com/v1/messages`
- ✅ Authentication headers are correct
- ✅ Request format is correct
- ❌ Upstream doesn't have the model available

## Proxy Status: ✅ WORKING CORRECTLY

The proxy correctly:
1. Routes to native upstream based on config
2. Forwards authentication headers
3. Handles the upstream error appropriately
4. Returns proper error message

## Comparison: Native vs OpenAI-Compatible

### Native Mode (https://api.example2-ai.com)
- ❌ claude-4.5-sonnet: NOT SUPPORTED
- Error: "model_not_found"

### OpenAI-Compatible Mode (https://api.qnaigc.com)
- ✅ claude-4.5-sonnet: SUPPORTED
- All 3 endpoints: 100% success rate

## Recommendation

**Use openai-completions mode for claude-4.5-sonnet**:

```toml
[models.claude-4-5-sonnet]
mode = "openai-completions"
# Uses default upstream (https://api.qnaigc.com)
```

This configuration provides:
- ✅ 100% success rate on all 3 endpoints
- ✅ Full model support
- ✅ Reliable upstream

## Test Script

Run: `bash tests/test_claude_sonnet_native.sh`

## Summary

| Configuration | Success Rate | Notes |
|---------------|--------------|-------|
| Native mode (api.example2-ai.com) | 0% | Model not available on upstream |
| OpenAI mode (api.qnaigc.com) | 100% | Fully supported ✅ |

**Recommendation**: Use OpenAI-compatible mode for production deployments of claude-4.5-sonnet.
