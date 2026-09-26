# Gemini 3.x Models Test Results - OpenAI-Compatible Upstream

## Date: 2026-02-26
## Models: gemini-3.1-pro-preview, gemini-3.0-flash-preview
## Upstream: https://api.qnaigc.com/v1 (OpenAI-compatible)
## Config: proxy_config.toml_oversea

---

## Summary

**gemini-3.1-pro-preview:** 0/2 (0%) ❌
**gemini-3.0-flash-preview:** 0/2 (0%) ❌

**Overall:** Both models not available on OpenAI-compatible upstream

---

## Test Results

### gemini-3.1-pro-preview

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

### gemini-3.0-flash-preview

- ❌ Non-stream - Target API returned error: 404
- ❌ Stream - Target API returned error: 404

**Config:**
```toml
[models.gemini-3-0-flash-preview]
mode = "openai-completions"
```

---

## Analysis

### Both Gemini 3.x Preview Models Not Available

**qnaigc upstream (OpenAI-compatible):**
- Does not have gemini-3.1-pro-preview
- Does not have gemini-3.0-flash-preview
- Returns 404 for both models

**Possible reasons:**
1. Preview/experimental models not deployed
2. Models require special access
3. Models only available on specific upstreams

---

## Comparison with Other Upstreams

### qnaigc (OpenAI-compatible) ❌
- gemini-3.1-pro-preview: 404
- gemini-3.0-flash-preview: 404

### example1 (Claude-compatible) ✅
- gemini-3.1-pro-preview: Works (tested directly)
- gemini-3.0-flash-preview: Unknown

---

## Working Gemini Models

### On qnaigc upstream ✅

**Gemini 2.x models:**
- gemini-2.5-flash: 100%
- gemini-2.5-pro: 100%
- gemini-2.0-flash: 100%

**Gemini 3.x models:**
- gemini-3.1-pro-preview: ❌ Not available
- gemini-3.0-flash-preview: ❌ Not available

---

## Recommendations

### ✅ Use These Models (qnaigc upstream)

**Stable Gemini 2.x:**
- gemini-2.5-pro (most capable)
- gemini-2.5-flash (fast)
- gemini-2.0-flash (stable)

---

### ❌ Avoid These Models (qnaigc upstream)

**Preview Gemini 3.x:**
- gemini-3.1-pro-preview (not available)
- gemini-3.0-flash-preview (not available)

---

### Alternative: Use example1 Upstream

For gemini-3.1-pro-preview, use example1 with model alias:

```toml
[models.example1-gemini31-pro]
mode = "native"
model_alias = "gemini-3.1-pro-preview"
base_url = "https://api.example1.com"
api_key = "sk-qeFSCTmVW61oSbOTFdrxi******"
```

---

## Conclusion

### Status: ❌ Not Available (0%)

**Both Gemini 3.x preview models are not available on qnaigc (OpenAI-compatible) upstream:**
- gemini-3.1-pro-preview: 404 error
- gemini-3.0-flash-preview: 404 error

**Recommendation:**
Use stable Gemini 2.5 models (gemini-2.5-pro or gemini-2.5-flash) which have 100% success rate on qnaigc upstream.

**Alternative:**
Use example1 upstream with model alias for gemini-3.1-pro-preview (requires workaround).

---

## Files

- `tests/test_gemini3_models.sh` - Test script
- `docs/gemini3_models_openai_upstream_test.md` - This file
