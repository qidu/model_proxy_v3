# gemini-3.0-flash-preview Test Results

## Date: 2026-02-26
## Model: gemini-3.0-flash-preview
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
[models.gemini-3-flash-preview]
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

[models.gemini-3-flash-preview]
mode = "openai-completions"
```

---

## Analysis

### Error: 404 Not Found

Both upstreams return 404 error, indicating:
1. Model does not exist on these upstreams
2. Model name is incorrect
3. Model requires special access/permissions

### Possible Reasons

1. **Preview/Experimental Model**
   - gemini-3.0-flash-preview is a preview model
   - May not be widely deployed yet
   - Limited availability

2. **Model Name Issue**
   - Correct name might be different
   - Could be "gemini-3-flash-preview" vs "gemini-3.0-flash-preview"
   - Upstream may use different naming

3. **Access Restrictions**
   - Preview models may require special access
   - Not available on public upstreams
   - Requires direct Google API access

---

## Comparison with Other Gemini Models

### Working Models ✅

**gemini-2.0-flash:**
- Native mode: 100% ✅
- OpenAI mode: 100% ✅

**gemini-2.5-flash:**
- Native mode: 100% ✅
- OpenAI mode: 100% ✅

**gemini-2.5-pro:**
- Native mode: 100% ✅
- OpenAI mode: 100% ✅

### Failed Model ❌

**gemini-3.0-flash-preview:**
- Native mode: 0% ❌
- OpenAI mode: 0% ❌
- Not available on any upstream

---

## Recommendations

### ✅ Use These Instead

**For latest Gemini:**
- gemini-2.5-flash (recommended)
- gemini-2.5-pro (more capable)
- gemini-2.0-flash (stable)

### ❌ Avoid

**gemini-3.0-flash-preview:**
- Not available on tested upstreams
- Use gemini-2.5-flash instead

---

## Conclusion

### Status: ❌ Not Available (0%)

**gemini-3.0-flash-preview is not available on either upstream:**
- Native mode (example1): 404 error
- OpenAI mode (qnaigc): 404 error

**Recommendation:**
Use gemini-2.5-flash or gemini-2.5-pro instead, both have 100% success rate in both modes.

---

## Files

- `tests/test_gemini3_quick.sh` - Test script
- `docs/gemini3_flash_preview_test_results.md` - This file
