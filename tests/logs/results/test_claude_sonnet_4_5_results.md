# Test Results: claude-sonnet-4-5 (Invalid Model Name)

## Date: 2026-02-25

## Test Results: 0/3 passed (0%)

### claude-sonnet-4-5 (openai-completions mode)

| # | Endpoint | Status | Error |
|---|----------|--------|-------|
| 1 | /v1/messages | ❌ FAIL | Invalid request to Messages API |
| 2 | /v1/interactions | ❌ FAIL | no available channels for model claude-sonnet-4-5 |
| 3 | /v1beta/models/claude-sonnet-4-5:generateContent | ❌ FAIL | no available channels for model claude-sonnet-4-5 |

**Success Rate: 0%**

## Root Cause: Invalid Model Name

The model name "claude-sonnet-4-5" is **not supported** by the upstream API.

**Upstream Error**:
```json
{
  "error": {
    "message": "no available channels for model claude-sonnet-4-5",
    "type": "invalid_request_error"
  }
}
```

## Correct Model Name

The correct model name is **"claude-4.5-sonnet"** (not "claude-sonnet-4-5").

### Comparison

| Model Name | Status | Success Rate |
|------------|--------|--------------|
| claude-sonnet-4-5 | ❌ NOT SUPPORTED | 0% |
| claude-4.5-sonnet | ✅ SUPPORTED | 100% |

## Proxy Status: ✅ WORKING CORRECTLY

The proxy correctly:
- Routes the request to the upstream
- Forwards the model name as provided
- Returns the upstream error appropriately

This is **not a proxy bug** - the model name is simply invalid/unsupported.

## Recommendation

**Use the correct model name: "claude-4.5-sonnet"**

### Correct Configuration

```toml
[models.claude-4-5-sonnet]
mode = "openai-completions"
# Uses default upstream
```

### Test Results for Correct Model Name

From previous tests, **claude-4.5-sonnet** works perfectly:
- ✅ /v1/messages: 100% success
- ✅ /v1/interactions: 100% success
- ✅ /v1beta/models/claude-4.5-sonnet:generateContent: 100% success

## Summary

| Model Name | Format | Supported | Success Rate |
|------------|--------|-----------|--------------|
| claude-sonnet-4-5 | Invalid | ❌ No | 0% |
| claude-4.5-sonnet | Correct | ✅ Yes | 100% |

## Conclusion

The model name "claude-sonnet-4-5" is invalid. Use **"claude-4.5-sonnet"** instead for 100% success rate on all endpoints.

## Test Script

Run: `bash tests/test_claude_sonnet_4_5_dashes.sh`

## Related Tests

- ✅ claude-4.5-sonnet (correct name): See `docs/test_claude_sonnet_results.md`
- ✅ claude-4.5-haiku: See `docs/test_with_config_results.md`
