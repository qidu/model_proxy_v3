# Test Results: Unconfigured Models

**Date**: 2026-02-28  
**Status**: ✅ All Tests Passed

## Test Configuration

### Minimal Config (No Specific Model IDs)
```toml
[upstream]
default_base_url = "https://api.qnaigc.com"
default_api_key = "sk-28f417e15b4643913bce23520d5948327c5986d4ca84647052703b2fa41af3dc"
upstream_mode = "openai-completions"

[models.default]
upstream_mode = "openai-completions"
# Inherits base_url and api_key from [upstream]

[models.list]
default_list = "/v1/models"
test_list = []
```

## Test Results Summary

### 1. DeepSeek Models Test
**Models Tested**: 2 models (deepseek/deepseek-v3.2, deepseek-r1)  
**Endpoints**: 3 endpoints per model  
**Result**: ✅ **6/6 tests passed (100%)**

```
Model: deepseek/deepseek-v3.2
---
  /v1/messages: ✅ chatcmpl-02d17026268a4ab292b622f5b03c6e36
  /v1/interactions: ✅ v1_1772260872940_req_1772260869470_e3ntuphzi
  generateContent: ✅ chatcmpl-55dca11ae6fe451a81b75d1c8fb9bca0

Model: deepseek-r1
---
  /v1/messages: ✅ chatcmpl-74cd34f309ef4f35ae78d2be45199870
  /v1/interactions: ✅ v1_1772260888087_req_1772260881773_bas9vz8p9
  generateContent: ✅ chatcmpl-0439df6675204505a10c456211849d3c
```

### 2. Thinking Models Test
**Models Tested**: 4 models  
- deepseek/deepseek-v3.2-exp-thinking
- qwen3-vl-30b-a3b-thinking
- doubao-seed-1.6-thinking
- moonshotai/kimi-k2-thinking

**Endpoints**: 3 endpoints per model  
**Result**: ✅ **12/12 tests passed (100%)**

```
Model: deepseek/deepseek-v3.2-exp-thinking
---
  /v1/messages: ✅ chatcmpl-55e92d4e610147f4941ade0a8ec2e5a9
  /v1/interactions: ✅ v1_1772260921775_req_1772260918253_ulskk51r9
  generateContent: ✅ chatcmpl-789a507fa8d044789e674c26854665eb

Model: qwen3-vl-30b-a3b-thinking
---
  /v1/messages: ✅ chatcmpl-8b18be3fc7174996a3783c90f4a0d486
  /v1/interactions: ✅ v1_1772260934885_req_1772260928163_x6olyu29x
  generateContent: ✅ chatcmpl-2271ed8cdc294f57818d1db2903fe965

Model: doubao-seed-1.6-thinking
---
  /v1/messages: ✅ chatcmpl-211b99a19d234ba18b50c9225f28ab1b
  /v1/interactions: ✅ v1_1772260949730_req_1772260943626_pufvdg0ya
  generateContent: ✅ chatcmpl-0243e2b26da1473e973647f23417ec20

Model: moonshotai/kimi-k2-thinking
---
  /v1/messages: ✅ chatcmpl-289a76aaacdd45b5a61f8cc075149641
  /v1/interactions: ✅ v1_1772260959251_req_1772260957264_t5bciwfv2
  generateContent: ✅ chatcmpl-55f6bd04fb2544cc80107916e91abd11
```

### 3. SSE Streaming Test
**Models Tested**: 2 models  
- deepseek/deepseek-v3.2
- qwen-max-2025-01-25

**Endpoints**: 3 streaming endpoints per model  
**Result**: ✅ **6/6 tests passed (100%)**

```
Model: deepseek/deepseek-v3.2
---
  /v1/messages (stream): ✅ SSE (4 events)
  /v1/interactions (stream): ✅ SSE (5 events)
  streamGenerateContent: ✅ SSE (5 events)

Model: qwen-max-2025-01-25
---
  /v1/messages (stream): ✅ SSE (4 events)
  /v1/interactions (stream): ✅ SSE (5 events)
  streamGenerateContent: ✅ SSE (5 events)
```

## Overall Results

| Test Suite | Models | Tests | Passed | Failed | Success Rate |
|------------|--------|-------|--------|--------|--------------|
| DeepSeek Models | 2 | 6 | 6 | 0 | 100% |
| Thinking Models | 4 | 12 | 12 | 0 | 100% |
| SSE Streaming | 2 | 6 | 6 | 0 | 100% |
| **Total** | **8** | **24** | **24** | **0** | **100%** |

## Routing Behavior

All unconfigured models correctly followed the fallback chain:

```
Request → Model not in config → [models.default] → [upstream] defaults
```

**Observed routing from logs:**
```
Model: deepseek/deepseek-v3.2, Mode: openai-completions, TargetURL: https://api.qnaigc.com
Model: deepseek-r1, Mode: openai-completions, TargetURL: https://api.qnaigc.com
Model: qwen3-vl-30b-a3b-thinking, Mode: openai-completions, TargetURL: https://api.qnaigc.com
Model: doubao-seed-1.6-thinking, Mode: openai-completions, TargetURL: https://api.qnaigc.com
Model: moonshotai/kimi-k2-thinking, Mode: openai-completions, TargetURL: https://api.qnaigc.com
Model: qwen-max-2025-01-25, Mode: openai-completions, TargetURL: https://api.qnaigc.com
```

## Key Findings

1. ✅ **Unconfigured models work perfectly** - All models without explicit configuration use the default settings
2. ✅ **All 3 endpoints supported** - `/v1/messages`, `/v1/interactions`, and `/v1beta/models/{model}:generateContent`
3. ✅ **SSE streaming works** - All streaming endpoints function correctly with unconfigured models
4. ✅ **Thinking models supported** - Reasoning models work without special configuration
5. ✅ **Consistent routing** - All models route to the same upstream with the same mode

## Configuration Hierarchy Verified

The fallback chain works as documented:

```
1. Model-specific config (not present in test)
   ↓
2. [models.default].upstream_mode = "openai-completions"
   ↓
3. [upstream].default_base_url = "https://api.qnaigc.com"
   [upstream].default_api_key = "sk-..."
   ↓
4. Hardcoded defaults (not needed)
```

## Conclusion

✅ **The refactored configuration system works perfectly for unconfigured models.**

All models without explicit configuration in `proxy_config.toml` successfully:
- Route to the default upstream
- Use the default API key
- Support all 3 endpoint formats
- Support SSE streaming
- Handle thinking/reasoning models

This validates that the removal of `FIXED_ROUTE_TARGET_URL` and `FIXED_ROUTE_PATH_PREFIX` environment variables was successful, and the new config-based approach provides a clean, consistent fallback mechanism.
