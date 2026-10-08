# Gemini generateContent/streamGenerateContent Endpoint Review

**Date:** 2026-02-28  
**Reviewer:** Code Analysis  
**Scope:** `/v1beta/models/{model}:generateContent` and `:streamGenerateContent` endpoints

## Executive Summary

The generateContent endpoints have **critical field naming issues** that prevent compatibility with Vertex AI Gemini API. The converter uses snake_case but the API requires camelCase.

**Status:** ❌ Non-compliant with Vertex AI Gemini API specification

---

## Detailed Findings

### ✅ What's Correct

#### 1. Request Structure
The `convertClaudeToGeminiRequest` function correctly generates:
- `contents` array with `role` and `parts` structure
- `parts` with `text` field for text content
- Image support with base64 data
- System instruction support
- Generation config with temperature and max tokens

#### 2. Response Parsing
The `convertGeminiGenerateContentToClaude` function correctly:
- Parses `candidates` array
- Extracts `content.parts[].text` fields
- Maps `finishReason` (STOP → end_turn, MAX_TOKENS → max_tokens)
- Extracts `usageMetadata` (promptTokenCount, candidatesTokenCount)

#### 3. URL Construction
- Correctly builds `/v1/models/{model}:generateContent` endpoint
- Correctly builds `/v1/models/{model}:streamGenerateContent` endpoint
- Proper model ID extraction and URL reconstruction

---

## ❌ Critical Issues

### Issue #1: Field Naming Convention (CRITICAL)

**Location:** `src/converters/claude-to-gemini.ts:12-70`

The converter uses **snake_case** but Vertex AI Gemini API requires **camelCase**.

#### Current Implementation (WRONG):
```typescript
// System instruction
request.system_instruction = { parts: [{ text: claudeRequest.system }] };

// Generation config
request.generation_config = {
    temperature: claudeRequest.temperature,
    max_output_tokens: claudeRequest.max_tokens
};

// Image data
parts.push({
    inline_data: {
        mime_type: imgBlock.source.media_type || 'image/jpeg',
        data: imgBlock.source.data
    }
});
```

#### Expected Format (per ../reference/vertex-ai-gemini-api.md):
```typescript
// System instruction
request.systemInstruction = { parts: [{ text: claudeRequest.system }] };

// Generation config
request.generationConfig = {
    temperature: claudeRequest.temperature,
    maxOutputTokens: claudeRequest.max_tokens
};

// Image data
parts.push({
    inlineData: {
        mimeType: imgBlock.source.media_type || 'image/jpeg',
        data: imgBlock.source.data
    }
});
```

#### API Specification Reference:
From `../api/vertex-ai-gemini-api.md`:
```json
{
  "contents": [...],
  "systemInstruction": {
    "parts": [{ "text": "You are a helpful coding assistant." }]
  },
  "generationConfig": {
    "stopSequences": ["END"],
    "temperature": 0.9,
    "maxOutputTokens": 8192,
    "topP": 0.95,
    "topK": 40
  }
}
```

**Impact:** All requests with system instructions, generation config, or images will fail or be ignored by upstream Gemini API.

---

## ⚠️ Missing Features

### 1. Safety Settings
**Status:** Not implemented  
**API Support:** Yes (per ../reference/vertex-ai-gemini-api.md)

```json
{
  "safetySettings": [
    {
      "category": "HARM_CATEGORY_HARASSMENT",
      "threshold": "BLOCK_MEDIUM_AND_ABOVE"
    }
  ]
}
```

### 2. Tools / Function Calling
**Status:** Not implemented  
**API Support:** Yes (per ../reference/vertex-ai-gemini-api.md)

```json
{
  "tools": [
    {
      "functionDeclarations": [
        {
          "name": "get_weather",
          "description": "Get weather for a location",
          "parameters": {
            "type": "object",
            "properties": {
              "location": { "type": "string" }
            }
          }
        }
      ]
    }
  ]
}
```

### 3. File Data (External Files)
**Status:** Only `inlineData` supported  
**API Support:** Yes (per ../reference/vertex-ai-gemini-api.md)

```json
{
  "fileData": {
    "mimeType": "audio/mp3",
    "fileUri": "gs://bucket/audio.mp3"
  }
}
```

### 4. Additional Generation Config Fields
**Status:** Only `temperature` and `maxOutputTokens` supported  
**Missing:**
- `stopSequences` (array of strings)
- `topP` (float)
- `topK` (integer)

### 5. Response Features
**Status:** Only text extraction implemented  
**Missing:**
- Multiple candidates handling
- `functionCall` parts (tool use responses)
- `safetyRatings` array
- `tokenCount` per candidate

---

## Test Coverage

### Tested Scenarios (from ../../tests/logs/results/test_results_unconfigured_models.md):
- ✅ Basic text generation
- ✅ Streaming responses (SSE)
- ✅ Multiple models (gemini-2.5-flash, gemini-3.x-preview)
- ✅ Thinking/reasoning models

### Untested Scenarios:
- ❌ System instructions (may fail due to snake_case)
- ❌ Generation config parameters (may fail due to snake_case)
- ❌ Image inputs (may fail due to snake_case)
- ❌ Safety settings
- ❌ Function calling / tools
- ❌ External file references

---

## Recommendations

### Priority 1: Critical (Blocking)
**Fix field naming convention**
- Change `system_instruction` → `systemInstruction`
- Change `generation_config` → `generationConfig`
- Change `max_output_tokens` → `maxOutputTokens`
- Change `inline_data` → `inlineData`
- Change `mime_type` → `mimeType`

**Files to modify:**
- `src/converters/claude-to-gemini.ts` (request conversion)
- `src/converters/gemini-to-claude.ts` (response parsing if needed)

### Priority 2: Important (Feature Parity)
**Add missing API features:**
1. `safetySettings` support
2. `tools` / `functionDeclarations` support
3. `stopSequences`, `topP`, `topK` in generationConfig
4. `fileData` support for external files

### Priority 3: Enhancement (Nice to Have)
**Improve response handling:**
1. Parse multiple candidates
2. Handle `functionCall` parts
3. Extract `safetyRatings`
4. Return per-candidate `tokenCount`

---

## Code References

### Request Conversion
- **File:** `src/converters/claude-to-gemini.ts`
- **Function:** `convertClaudeToGeminiRequest` (lines 12-70)
- **Handler:** `handleGeminiGenerateContentRequest` (lines 480-577 in `src/handlers/gemini.ts`)

### Response Conversion
- **File:** `src/converters/gemini-to-claude.ts`
- **Function:** `convertGeminiGenerateContentToClaude` (lines 171-232)
- **Handler:** `handleGeminiNonStreamingResponse` (lines 674-719 in `src/handlers/gemini.ts`)

### URL Construction
- **File:** `src/handlers/gemini.ts`
- **Function:** `constructGeminiUrl` (lines 591-607)

---

## API Specification Compliance

| Feature | API Spec | Implementation | Status |
|---------|----------|----------------|--------|
| `contents` array | ✅ Required | ✅ Implemented | ✅ Pass |
| `role` field | ✅ Required | ✅ Implemented | ✅ Pass |
| `parts` array | ✅ Required | ✅ Implemented | ✅ Pass |
| `text` field | ✅ Required | ✅ Implemented | ✅ Pass |
| `systemInstruction` | ✅ Optional | ❌ Wrong case | ❌ Fail |
| `generationConfig` | ✅ Optional | ❌ Wrong case | ❌ Fail |
| `maxOutputTokens` | ✅ Optional | ❌ Wrong case | ❌ Fail |
| `inlineData` | ✅ Optional | ❌ Wrong case | ❌ Fail |
| `mimeType` | ✅ Optional | ❌ Wrong case | ❌ Fail |
| `safetySettings` | ✅ Optional | ❌ Not implemented | ⚠️ Missing |
| `tools` | ✅ Optional | ❌ Not implemented | ⚠️ Missing |
| `fileData` | ✅ Optional | ❌ Not implemented | ⚠️ Missing |
| `stopSequences` | ✅ Optional | ❌ Not implemented | ⚠️ Missing |
| `topP` / `topK` | ✅ Optional | ❌ Not implemented | ⚠️ Missing |

**Overall Compliance:** ❌ **Non-compliant** (critical field naming issues)

---

## Next Steps

1. **Immediate:** Fix field naming to use camelCase (Priority 1)
2. **Short-term:** Add test cases for system instructions, generation config, and images
3. **Medium-term:** Implement missing features (Priority 2)
4. **Long-term:** Enhance response handling (Priority 3)

---

## Related Documentation

- `../api/vertex-ai-gemini-api.md` - API specification
- `../../tests/logs/results/test_results_unconfigured_models.md` - Test results
- `../architecture/routing_refactor.md` - Routing architecture
- `src/converters/claude-to-gemini.ts` - Request converter
- `src/converters/gemini-to-claude.ts` - Response converter
