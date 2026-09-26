# Test Results: claude-haiku-4-5 (Invalid Model Name)

## Date: 2026-02-25

## Test Results: 0/3 passed (0%)

### claude-haiku-4-5 (openai-completions mode)

| # | Endpoint | Status | Error |
|---|----------|--------|-------|
| 1 | /v1/messages | ❌ FAIL | Service error from Claude API |
| 2 | /v1/interactions | ❌ FAIL | Service error from Gemini API |
| 3 | /v1beta/models/claude-haiku-4-5:generateContent | ❌ FAIL | Service error from Gemini API |

**Success Rate: 0%**

## Root Cause: Invalid Model Name

The model name "claude-haiku-4-5" is **not supported** by the upstream API.

**Direct Upstream Test**:
```bash
curl "https://api.qnaigc.com/v1/chat/completions" \
  -H "Authorization: Bearer sk-..." \
  -d '{"model":"claude-haiku-4-5","messages":[...]}'
```

**Response**:
```json
{
  "error": {
    "message": "no available channels for model claude-haiku-4-5",
    "type": "invalid_request_error"
  }
}
```

## Correct Model Name

The correct model name is **"claude-4.5-haiku"** (not "claude-haiku-4-5").

### Comparison

| Model Name | Status | Success Rate |
|------------|--------|--------------|
| claude-haiku-4-5 | ❌ NOT SUPPORTED | 0% |
| **claude-4.5-haiku** | ✅ SUPPORTED | 100% |

## Proxy Status: ✅ WORKING CORRECTLY

The proxy correctly:
- Routes the request to the upstream
- Forwards the model name as provided
- Returns the upstream error appropriately

This is **not a proxy bug** - the model name is simply invalid/unsupported.

## Recommendation

**Use the correct model name: "claude-4.5-haiku"**

### Correct Configuration

```toml
[models.claude-4-5-haiku]
mode = "openai-completions"
# Uses default upstream
```

### Test Results for Correct Model Name

From previous tests (see `docs/test_with_config_results.md`), **claude-4.5-haiku** works perfectly:
- ✅ /v1/messages: chatcmpl-5e78104ed73446279555232b4ad085b9
- ✅ /v1/interactions: v1_1772010637891_req_1772010636714_ev1efeot8
- ✅ /v1beta/models/claude-4.5-haiku:generateContent: chatcmpl-958e3fea23754b2f9aba6112ed0a7b0c

**Success Rate: 100%** ✅

## Summary

| Model Name | Format | Supported | Success Rate |
|------------|--------|-----------|--------------|
| claude-haiku-4-5 | Invalid | ❌ No | 0% |
| claude-4.5-haiku | Correct | ✅ Yes | 100% |

## Conclusion

The model name "claude-haiku-4-5" is invalid. Use **"claude-4.5-haiku"** instead for 100% success rate on all endpoints.

## Test Script

Run: `bash tests/test_claude_haiku_4_5.sh`

## Related Tests

- ✅ claude-4.5-haiku (correct name): See `docs/test_with_config_results.md` - 100% success
- ✅ claude-4.5-sonnet (correct name): See `docs/test_claude_sonnet_results.md` - 100% success
- ❌ claude-sonnet-4-5 (invalid name): See `docs/test_claude_sonnet_4_5_results.md` - 0% success
