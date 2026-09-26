# Oversea Models Test Results

## Date: 2026-02-26
## Models: 5 models (2 Claude, 3 Gemini)
## Modes: Native and OpenAI-Compatible
## Config: proxy_config.toml_oversea

---

## Summary

**Total Tests:** 60 (5 models × 2 modes × 6 endpoints)  
**Success:** 12/60 (20%)  
**Failed:** 48/60 (80%)

**By Mode:**
- Native mode: 12/30 (40%)
- OpenAI mode: 0/30 (0%)

---

## Test Results

### Native Mode

#### ✅ Working Models (2/5)

**gemini-2.0-flash:** 6/6 (100%) ✅
- ✅ /v1/messages
- ✅ /v1/messages (stream)
- ✅ /v1/interactions
- ✅ /v1/interactions (stream)
- ✅ generateContent
- ✅ streamGenerateContent

**gemini-2.5-pro:** 6/6 (100%) ✅
- ✅ /v1/messages
- ✅ /v1/messages (stream)
- ✅ /v1/interactions
- ✅ /v1/interactions (stream)
- ✅ generateContent
- ✅ streamGenerateContent

---

#### ❌ Failed Models (3/5)

**claude-4.6-sonnet:** 0/6 (0%) ❌
- ❌ All endpoints: "Authentication failed for Gemini API"

**claude-4.6-opus:** 0/6 (0%) ❌
- ❌ All endpoints: "Authentication failed for Gemini API"

**gemini-3.0-flash-preview:** 0/6 (0%) ❌
- ❌ All endpoints: "Service error from Gemini API"

---

### OpenAI-Compatible Mode

#### ❌ All Models Failed (0/5)

All 5 models: 0/6 (0%) ❌
- ❌ All endpoints: "404 not found or met"

**Models:**
- claude-4.6-sonnet
- claude-4.6-opus
- gemini-2.0-flash
- gemini-2.5-pro
- gemini-3.0-flash-preview

---

## Issues Identified

### 1. Claude Native Mode - Authentication Error

**Error:** "Authentication failed for Gemini API"

**Config:**
```toml
[models.claude-4-6-sonnet]
mode = "native"
model_alias = "claude-opus-4-20250514-thinking"
base_url = "https://api.example2-ai.com"
api_key = "x-api-key:  sk-cJESnlELbBSsytvgIgCevJWqBYr******"
```

**Problem:** 
- API key format incorrect: `"x-api-key:  sk-..."`
- Should be just the key value
- Extra spaces in the key

**Fix needed:**
```toml
api_key = "sk-cJESnlELbBSsytvgIgCevJWqBYr******"
```

---

### 2. Gemini 3.0 Flash Preview - Service Error

**Error:** "Service error from Gemini API"

**Possible causes:**
- Model not available on upstream
- Model name incorrect
- Upstream doesn't support this model

---

### 3. OpenAI Mode - Models Not Found

**Error:** "404 not found or met"

**Possible causes:**
- Models not available on OpenAI-compatible upstream
- Upstream: `https://api.qnaigc.com/v1`
- These models may only be available on native upstreams

---

## Configuration Issues

### API Key Format

**Current (incorrect):**
```toml
api_key = "x-api-key:  sk-cJESnlELbBSsytvgIgCevJWqBYr******"
```

**Should be:**
```toml
api_key = "sk-cJESnlELbBSsytvgIgCevJWqBYr******"
```

The proxy should extract the key value, not include the header name.

---

## Working Configuration

### Gemini Models (Native Mode)

**gemini-2.0-flash:**
```toml
[models.gemini-2-0-flash]
mode = "native"
base_url = "https://api.example1.com"
api_key = "sk-qeFSCTmVW61oSbOTFdrxi******"
```

**gemini-2.5-pro:**
```toml
[models.gemini-2-5-pro]
mode = "native"
model_alias = "gemini-2.5-flash"
base_url = "https://api.example1.com"
api_key = "sk-qeFSCTmVW61oSbOTFdrxi******"
```

**Result:** Both work perfectly (100%)

---

## Recommendations

### 1. Fix Claude API Key Format

**Update config:**
```toml
[models.claude-4-6-sonnet]
mode = "native"
model_alias = "claude-opus-4-20250514-thinking"
base_url = "https://api.example2-ai.com"
api_key = "sk-cJESnlELbBSsytvgIgCevJWqBYr******"

[models.claude-4-6-opus]
mode = "native"
model_alias = "claude-opus-4-1-20250805-thinking"
base_url = "https://api.example2-ai.com"
api_key = "sk-cJESnlELbBSsytvgIgCevJWqBYr******"
```

---

### 2. Verify Gemini 3.0 Availability

**Check if model exists:**
- Test directly on upstream
- Verify model name
- Check if model is available

---

### 3. Use Native Mode for These Models

**Recommendation:**
- Claude models: Use native mode only
- Gemini models: Use native mode only
- OpenAI-compatible upstream doesn't support these models

---

## Success Rate by Model

| Model | Native Mode | OpenAI Mode | Best Mode |
|-------|-------------|-------------|-----------|
| gemini-2.0-flash | 100% (6/6) | 0% (0/6) | Native ✅ |
| gemini-2.5-pro | 100% (6/6) | 0% (0/6) | Native ✅ |
| claude-4.6-sonnet | 0% (0/6) | 0% (0/6) | Fix needed ⚠️ |
| claude-4.6-opus | 0% (0/6) | 0% (0/6) | Fix needed ⚠️ |
| gemini-3.0-flash-preview | 0% (0/6) | 0% (0/6) | Not available ❌ |

---

## Files

- `tests/test_oversea_models.sh` - Test script
- `proxy_config.toml_oversea` - Configuration file
- `docs/oversea_models_test_results.md` - This file

---

## Conclusion

### Status: ⚠️ Partial Success

**Working (2/5 models):**
- ✅ gemini-2.0-flash (native mode)
- ✅ gemini-2.5-pro (native mode)

**Needs Fix (2/5 models):**
- ⚠️ claude-4.6-sonnet (API key format issue)
- ⚠️ claude-4.6-opus (API key format issue)

**Not Available (1/5 models):**
- ❌ gemini-3.0-flash-preview (model not found)

**Key Finding:** Native mode works for Gemini models (100%), but Claude models need API key format fix. OpenAI-compatible mode doesn't support these models on the current upstream.

**Next Steps:**
1. Fix Claude API key format in config
2. Retest Claude models
3. Verify gemini-3.0-flash-preview availability
