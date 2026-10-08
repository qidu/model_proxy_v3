# gemini-3.1-pro-preview Test Results

## Date: 2026-02-26
## Model: gemini-3.1-pro-preview
## Config: proxy_config.toml_oversea

---

## Summary

**Native Mode:** 0/2 (0%) ❌
**OpenAI-Compatible Mode:** 0/2 (0%) ❌

**Overall:** Model not available on any upstream

---

## Test Results

### Native Mode (example1 upstream)

- ❌ Non-stream - Target API returned error: 404
- ❌ Stream - Target API returned error: 404

**Config:**
```toml
[models.gemini-3-1-pro-preview]
mode = "native"
base_url = "https://api.example1.com"
api_key = "sk-qeFSCTmVW61oSbOTFdrxi******"
```

---

### OpenAI-Compatible Mode (qnaigc upstream)

- ❌ Non-stream - Target API returned error: 404
- ❌ Stream - Target API returned error: 404

**Config:**
```toml
[upstream]
default_url = "https://api.qnaigc.com/v1"
default_api_key = "sk-28f417e15b4643913bce23520d5948327c======"

[models.gemini-3-1-pro-preview]
mode = "openai-completions"
```

---

## Analysis

### Error: 404 Not Found

Both upstreams return 404 error, same as gemini-3.0-flash-preview.

### Gemini 3.x Models Status

**gemini-3.0-flash-preview:** ❌ Not available
**gemini-3.1-pro-preview:** ❌ Not available

Both Gemini 3.x preview models are not available on tested upstreams.

---

## Working Alternatives

### Gemini 2.x Models ✅

**gemini-2.5-flash:** 100% (both modes)
**gemini-2.5-pro:** 100% (both modes)
**gemini-2.0-flash:** 100% (both modes)

---

## Recommendation

**Use gemini-2.5-pro instead** - it's the most capable stable Gemini model with 100% success rate.

---

## Conclusion

### Status: ❌ Not Available (0%)

**gemini-3.1-pro-preview is not available on either upstream:**
- Native mode (example1): 404 error
- OpenAI mode (qnaigc): 404 error

**All Gemini 3.x preview models are unavailable. Use Gemini 2.5 models instead.**

---

## Files

- `tests/test_gemini3_quick.sh` - Test script
- `docs/gemini31_pro_preview_test_results.md` - This file
