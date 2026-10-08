# Analysis: model_alias Support for Gemini Native Mode

## Test Date: 2026-02-25

## Question
Does model_alias work for gemini-2-5-flash native mode?

## Test Configuration

```toml
[models.gemini-2-5-flash]
mode = "native"
model_alias = "gemini-2.5-flash-exp"  # Testing with alias
base_url = "https://api.example1.com"
api_key = "sk-..."
```

## Test Results: 1/3 passed (33%)

| Endpoint | Status | Error |
|----------|--------|-------|
| /v1/messages | ❌ FAIL | Service error from Claude API |
| /v1/interactions | ❌ FAIL | Model not found: gemini-2.5-flash-exp |
| /v1beta/models/*:generateContent | ✅ PASS | Works correctly |

## Root Cause Analysis

### ✅ Works for: /v1beta/models/*:generateContent

**Why it works:**
```typescript
// src/index.ts:380-386
} else if (path.startsWith('/v1beta/models/') && path.includes(':generateContent')) {
  handlerType = 'generateContent';
  const modelMatch = path.match(/\/v1beta\/models\/([^:?]+):generateContent/);
  const pathModelId = modelMatch ? modelMatch[1] : upstreamModelName;  // Uses path model, not alias
  if (modelRoute.mode === 'native') {
    targetUrl = `${modelRoute.targetUrl}/v1beta/models/${pathModelId}:generateContent`;
```

**Result:** Uses model name from URL path (gemini-2.5-flash), NOT the alias ✅

### ❌ Fails for: /v1/interactions

**Why it fails:**
```typescript
// src/index.ts:368-373
} else if (path === '/v1/interactions' || path.startsWith('/v1/interactions?')) {
  handlerType = 'interactions';
  if (modelRoute.mode === 'native') {
    // Native Gemini API - route to generateContent endpoint
    // Use upstream model name (with alias if configured)
    targetUrl = `${modelRoute.targetUrl}/v1beta/models/${upstreamModelName}:generateContent`;  // Uses alias!
```

**Result:** Uses model_alias (gemini-2.5-flash-exp) in URL, upstream rejects it ❌

**Error from upstream:**
```
failed to get available channel for model gemini-2.5-flash-exp in group lvip
no channels supporting this model[gemini-2.5-flash-exp] were found
```

### ❌ Fails for: /v1/messages

**Why it fails:**
```typescript
// src/index.ts:358-364
if (path === '/v1/messages' || path.startsWith('/v1/messages?')) {
  handlerType = 'messages';
  if (modelRoute.mode === 'native') {
    targetUrl = `${modelRoute.targetUrl}/v1/messages`;  // URL doesn't include model
    upstreamMode = 'native';
  }
```

**Then in handler:**
```typescript
// src/handlers/gemini.ts:481-482
effectiveModelId = effectiveModelId || (requestBody.model as string);
// effectiveModelId comes from index.ts as upstreamModelName (the alias)
```

**Result:** Uses model_alias in request body, upstream rejects it ❌

## Code Flow Analysis

### Current Implementation

1. **index.ts extracts model_alias:**
```typescript
const upstreamModelName = modelRoute.modelAlias || modelName;  // Line 347
modelId = upstreamModelName;  // Line 392
```

2. **Passes to handlers:**
```typescript
// For /v1/messages
return handleClaudeRequest(request, targetUrl, modelAuthHeaders, requestId, modelId, env, logger);

// For /v1/interactions
targetUrl = `${modelRoute.targetUrl}/v1beta/models/${upstreamModelName}:generateContent`;
return handleGeminiRequest(request, targetUrl, modelAuthHeaders, requestId, modelId, env, logger);

// For /v1beta/models/*:generateContent
const pathModelId = modelMatch ? modelMatch[1] : upstreamModelName;  // Uses path first!
targetUrl = `${modelRoute.targetUrl}/v1beta/models/${pathModelId}:generateContent`;
```

3. **Handlers use modelId:**
- Gemini handlers use it in request body or URL
- If alias is set, it replaces the original model name

## Issue Summary

### ✅ model_alias WORKS for Claude native mode
- Claude handler updates request body with alias
- Upstream accepts version-specific names (claude-haiku-4-5-20251001)

### ❌ model_alias DOES NOT WORK for Gemini native mode
- Gemini upstream expects standard model names (gemini-2.5-flash)
- Alias gets inserted into URL or request, upstream rejects it
- Only /v1beta/models/*:generateContent works because it uses path model name

## Recommendation

### Option 1: ❌ Do NOT support model_alias for Gemini native mode

**Reasons:**
1. Gemini upstreams don't use version-specific model names
2. Current implementation breaks /v1/messages and /v1/interactions
3. Only /v1beta/models/*:generateContent works (by accident)
4. No use case for Gemini model aliasing

**Action:** Document that model_alias is for Claude native mode only

### Option 2: ✅ Fix model_alias for Gemini native mode (if needed)

**Changes required:**
1. Don't use alias in URL for /v1/interactions
2. Don't use alias in request body for native Gemini
3. Only use alias for Claude native mode

**Code fix:**
```typescript
// src/index.ts
if (modelRoute.mode === 'native') {
  if (handlerType === 'messages' && targetUrl.includes('anthropic')) {
    // Only use alias for Claude
    modelId = upstreamModelName;
  } else {
    // Don't use alias for Gemini
    modelId = modelName;
  }
}
```

## Conclusion

### Current Status: ❌ BROKEN

**model_alias for Gemini native mode:**
- ❌ /v1/messages: Fails (uses alias in request)
- ❌ /v1/interactions: Fails (uses alias in URL)
- ✅ /v1beta/models/*:generateContent: Works (ignores alias, uses path)

### Recommendation: ❌ DO NOT USE model_alias for Gemini

**Best practice:**
```toml
# ✅ Correct - No alias needed
[models.gemini-2-5-flash]
mode = "native"
base_url = "https://api.example1.com"
api_key = "sk-..."

# ❌ Incorrect - Will break /v1/messages and /v1/interactions
[models.gemini-2-5-flash]
mode = "native"
model_alias = "gemini-2.5-flash-exp"  # Don't do this!
base_url = "https://api.example1.com"
api_key = "sk-..."
```

### Documentation Update Needed

Add to README.md:
```markdown
## model_alias Feature

**Supported for:**
- ✅ Claude native mode (version-specific names)
- ✅ OpenAI-compatible mode (any model mapping)

**NOT supported for:**
- ❌ Gemini native mode (use standard model names)

**Example:**
```toml
# Claude native - model_alias works
[models.claude-4-5-haiku]
mode = "native"
model_alias = "claude-haiku-4-5-20251001"

# Gemini native - no alias needed
[models.gemini-2-5-flash]
mode = "native"
# No model_alias - upstream expects gemini-2.5-flash
```
```

## Test Script

Run: `bash tests/test_gemini_model_alias.sh`

## Summary

| Aspect | Status | Notes |
|--------|--------|-------|
| model_alias for Gemini | ❌ Broken | Fails 2/3 endpoints |
| Use case for Gemini | ❌ None | Gemini uses standard names |
| Recommendation | ❌ Don't use | Keep config without alias |
| Fix needed | ⚠️ Optional | Only if use case exists |
