# Routing Refactoring

**Date**: 2026-02-27  
**Status**: ✅ Complete

## Implementation

### Main Router

```typescript
case 'messages':
  // /v1/messages routes based on upstream_mode
  if (upstreamMode === 'anthropic-messages') {
    // using keys (`x-api-key` first) from endpoint as `x-api-key` for upstream
    response = await handleClaudeRequest(...); // pass through to Claude API
  } else { // upstreamMode === 'openai-completions'
    // using keys from endpoint as `Authorization: Bearer` for upstream
    response = await handleMessagesRequest(...); // convert to OpenAI format
  }
  break;

case 'interactions':
  // /v1/interactions routes based on upstream_mode
  if (upstreamMode === 'gemini-interactions') {
    // using keys (`x-goog-api-key` first) from endpoint as `x-goog-api-key` for upstream
    response = await handleGeminiRequest(...); // pass through to Gemini API
  } else { // upstreamMode === 'openai-completions'
    // using keys from endpoint as `Authorization: Bearer` for upstream
    response = await handleOpenAIRequest(...); // convert to OpenAI format
  }
  break;

case 'generateContent':
  // /v1beta/models/{model}:generateContent routes based on upstream_mode
  if (upstreamMode === 'gemini-generatecontent') {
    // using keys (`x-goog-api-key` first) from endpoint as `x-goog-api-key` for upstream
    response = await handleGeminiRequest(...); // pass through to Gemini API
  } else { // upstreamMode === 'openai-completions'
    // using keys from endpoint as `Authorization: Bearer` for upstream
    response = await handleOpenAIRequest(...); // convert to OpenAI format
  }
  break;
case 'streamGenerateContent':
  // /v1beta/models/{model}:streamGenerateContent routes based on upstream_mode
  // same as 'generateContent' but with SSE support
  break;

case 'responses':
  // /responses routes based on upstream_mode
  if (upstreamMode === 'openai-responses') {
    // using keys from endpoint as `Authorization: Bearer` for upstream
    response = await handleResponsesRequest(...); // pass through to OpenAI Responses API
  } else { // upstreamMode === 'openai-completions'
    // using keys from endpoint as `Authorization: Bearer` for upstream
    response = await handleResponsesRequest(...); // convert to OpenAI Chat Completions format
  }
  break;

## Upstream URI Mappings

Each `upstream_mode` maps to a specific upstream API endpoint:

- **`openai-completions`** → `/v1/chat/completions` both streaming and non-streaming
- **`anthropic-messages`** → `/v1/messages` both streaming and non-streaming
- **`gemini-generatecontent`** → `/v1beta/models/{model}:generateContent` (non-streaming) or `/v1beta/models/{model}:streamGenerateContent` (streaming)
- **`gemini-interactions`** → `/v1/interactions` both streaming and non-streaming
- **`openai-responses`** → `/responses` both streaming and non-streaming (passthrough only)

The proxy automatically constructs the full upstream URL by combining `base_url` + URI path based on the configured `upstream_mode`.

## Routing Flow

```
    ┌────────────────────────────────────────────────────────────────────────────┐
    │                       Users Requests                                       │
    │  /v1/messages     | /v1/responses   |                                      │
    │  /v1/interactions | /v1beta/models/{model}:contentGenerate                 │
    └────────────────────────────┬───────────────────────────────────────────────┘
                                 │
                                 ▼
                        parseFixedRoute()
                                 │
                                 ▼
                  { handlerType, upstreamMode, targetUrl }
                                 │
                                 ▼
                        switch(handlerType)
                                 │
        ┌────────────────────────┼───────────────────────────┬────────────────────┐
        │                        │                           │                    │
        ▼                        ▼                           ▼                    ▼
   'messages'              'interactions'             'generateContent'        'responses'
        │                        │                           │                    │
 check upstream_mode      check upstream_mode          check upstream_mode   check upstream_mode
        │                        │                           │                    │
   ┌────┴────┐              ┌────┴───────┐            ┌──────┴─────────┐       ┌────┴────────┐
   ▼         ▼              ▼            ▼            ▼                ▼       ▼             ▼
'anthropic' 'openai-     'gemini-      'openai-     'gemini-          'openai-''openai-    'openai-
'-messages' completions' interactions' completions' generatecontent'  completions'responses' completions'
   │         │              │            │            │                │        │            │
   ▼         ▼              ▼            ▼            ▼                ▼        ▼            ▼
handleClaude handleMessages handleGemini handleOpenAI handleGemini   handleOpenAI handleResponses handleResponses
Request()    Request()      Request()    Request()    Request()        Request()  Request()     Request()
   │         │              │            │              │              │          │            │
   │         │              │            │              │              │          │            │
   ▼         ▼              ▼            ▼              ▼              ▼          ▼            ▼
AWS/Vertex  OpenAI        Gemini API  OpenAI        Gemini API       OpenAI     OpenAI       OpenAI
Claude API  Compatible    /v1/         Compatible    /v1beta/models/  Compatible /responses    /v1/chat/
/v1/        /v1/chat/     interactions /v1/chat/     {model}:         /v1/chat/              completions
messages    completions                completions   generate         completions
                                                     Content

# 
# "gemini-*" stands for both "gemini-generatecontent" and "gemini-interactions"
```

### Model-based Upstream Configuration

Current implementation supports **single upstream per model** via `proxy_config.toml`:

#### What is a "Category"?

A **category** is a `[models.<name>]` section in the config that groups related models sharing the same upstream configuration. Each category defines:

1. **Shared defaults**: `upstream_mode`, `base_url`, `api_key` that apply to all models in the category
2. **Per-model overrides**: Individual models can override any of these defaults using the array format

**Key characteristics:**
- Category name (e.g., `gemini`, `claude`, `default`) is arbitrary - you choose it for organizational purposes
- Models within a category inherit the category's `base_url`, `api_key`, and `upstream_mode` unless explicitly overridden
- A model can only belong to one category (the section where it's defined)
- Special category `[models.default]` acts as fallback for models not explicitly configured elsewhere

**Example:**
```toml
[models.gemini]  # ← Category name: "gemini"
upstream_mode = "gemini-generatecontent"
base_url = "https://api.example.com"  # ← Category defaults
api_key = "sk-gemini-key"
# gemini models in the section inherit the category's base_url and api_key:
"gemini-3.1-pro-preview" = ["", "", ""]
# gemini models NOT in the section fall back to default upstream

[models.claude]  # ← Category name: "claude"
upstream_mode = "anthropic-messages"
# claude models in the section inherit the category's base_url and api_key:
"claude-4.5-sonnet" = ["claude-opus-4-1-20250805-thinking", "", ""]  # Override alias only
# claude models NOT in the section fall back to default upstream

[models.default]
# models in the section inherit the category's base_url and api_key:
# models NOT in the section fall back to default upstream

```

#### Per-Model Configuration Array Format

Each model within a category can be configured using a **3-element array**:

```toml
"<model-id>" = ["<model-alias>", "<base-url>", "<api-key>"]
```

**Array elements:**
1. **model-alias**: Upstream model name (empty `""` = use original model ID)
2. **base-url**: Override category base_url (empty `""` = inherit from category)
3. **api-key**: Override category api_key (empty `""` = inherit from category)

**Inheritance rules:**
- **REQUIRED format**: `["", "", ""]` - MUST use 3-element array with empty strings to inherit from category
- **Empty array `[]` is INVALID** - Parser will reject this format
- **Partial override**: `["custom-name", "", ""]` - Override alias only, inherit base_url and api_key
- **Full override**: `["alias", "https://url", "sk-key"]` - Override all three values

**Fallback chain:**
```
Model array value → Category default → [upstream] default → Error
```

**Examples:**

```toml
# ✅ Correct: Inherit all from category
"gemini-2.5-flash" = ["", "", ""]

# ✅ Correct: Override model alias only
"claude-4.6-sonnet" = ["claude-opus-4-1-20250805-thinking", "", ""]

# ✅ Correct: Override all three
"gemini-3.0-flash-preview" = ["gemini-3-flash-preview", "https://custom.com", "sk-custom"]

# ❌ INVALID: Empty array not supported
"gemini-2.5-flash" = []

# ❌ INVALID: Missing elements
"model-name" = ["alias"]
```

#### Configuration Structure

```toml
# proxy_config.toml
[upstream]
# Global defaults upstream for models in list and test list but without explicit single or explicit category configuration
# upstream_mode is OPTIONAL here - only used if [models.default] is missing
upstream_mode = "openai-completions"
default_base_url = "https://api.qnaigc.com"
default_api_key = "sk-default-key"

# Category for OpenAI-compatible models (fallback)
# IMPORTANT: This category's upstream_mode takes precedence over [upstream].upstream_mode
# Precedence chain: [models.default].upstream_mode → [upstream].upstream_mode
[models.default]
upstream_mode = "openai-completions"

# Category for Gemini models
# IMPORTANT: Choose ONE upstream_mode per category (mutually exclusive):
# - "gemini-generatecontent" for /v1beta/models/{model}:generateContent endpoint
# - "gemini-interactions" for /v1/interactions endpoint
# Cannot use both modes simultaneously in the same category
[models.gemini]
upstream_mode = "gemini-generatecontent"
# upstream_mode = "gemini-interactions"  # Alternative mode (comment out one)
base_url = "https://api.example1.com"
api_key = "sk-gemini-key"
# Models inherit category defaults using ["", "", ""] format
"gemini-2.5-flash" = ["", "", ""]  # Inherits all from category
"gemini-3.1-pro-preview" = ["", "", ""]  # Inherits all from category
"gemini-3.0-flash-preview" = ["gemini-3-flash-preview", "https://custom.com", "sk-custom"]  # Overrides all

[models.claude]
upstream_mode = "anthropic-messages"
base_url = "https://api.anthropic.com"
api_key = "sk-claude-key"
# Model alias example: map client name to upstream name
"claude-4.5-sonnet" = ["claude-opus-4-1-20250805-thinking", "", ""]  # Override alias only
# Available upstream model names (can be used as aliases):
# - claude-opus-4-1-20250805
# - claude-opus-4-1-20250805-thinking
# - claude-3-5-sonnet-20240620
# - claude-haiku-4-5-20251001-thinking

[models.list]
# Model list configuration for /v1/models endpoint
default_list = "/v1/models"  # Fetch from default upstream
test_list = ["custom-model-1", "custom-model-2"]  # Append custom models
```

**Model Naming Convention:**
- **Section names** use simplified category prefixes: `[models.gemini]`, `[models.claude]`, `[models.default]`
- **Model IDs** (config keys) preserve original names with `/` and `.`: `"deepseek/deepseek-v3.2"`, `"gemini-2.5-flash"`
- No normalization is applied to model IDs in configuration

#### Model List Configuration

The `[models.list]` section controls the `/v1/models` endpoint response:

```toml
[models.list]
default_list = "/v1/models"  # Endpoint to fetch base model list
test_list = ["model-a", "model-b"]  # Additional models to append
```

- **default_list**: Upstream endpoint path to fetch models from
- **test_list**: Array of custom model IDs to append to the response

### Future Feature: Multiple Upstreams per Model

**Status**: 📋 Planned (not yet implemented)

Load balancing and failover support with multiple upstreams.

See `multiple_upstream_analysis.md` for implementation plan.


### API Specifications
- **`gemini-interactions`** : Support Gemini '/v1/interactions' input and output,  Spec refered to `../api/interactions.md`
- **`gemini-generatecontent`** : Support Gemini '/v1beta/models/{model}:generateContent' input and output, Spec refered to `../api/vertex-ai-gemini-api.md` without `/v1/projects/{project}/locations/{location}/publishers` in URI
- **stream `gemini-generatecontent`** : Support Gemini SSE stream '/v1beta/models/{model}:streamGenerateContent' input and output, Spec refered to `../api/vertex-ai-gemini-api.md` without `/v1/projects/{project}/locations/{location}/publishers` in URI
- **`anthropic-messages`** : Support Claude '/v1/messages' Spec refered to files in `../api/claude_api_docs/*.md` , espetially following docs:
  - `../api/claude_api_docs/messages-api.md` - High-level guide for getting started
  - `../api/claude_api_docs/messages-create.md` - Complete reference for the main endpoint
  - `../api/claude_api_docs/messages-count-tokens.md` - Specialized reference for token counting
  - `../api/claude_api_docs/versioning.md` - API version and other pamameters

- **`openai-responses`** → `/v1/responses` Support OpenAI Responses API (`../api/openai-response.md`)
- **`openai-completions`** → `/v1/chat/completions` Blocked from Endpoint (`../api/openai-api-reference.md`)


### Authentications
#### API Keys in reqeusts Headers got from Endpoints
- `x-api-key` : for `/v1/messages` endpoint
- `x-goog-api-key` : for both `/v1beta/models/{model}:` and `/v1/interactions`
- `Authorization: Bearer` : using this key from all endpointfor all models if no `x-api-key` and no `x-goog-api-key`

#### API Keys in reqeust Headers sendig to Uptreams
- `x-api-key` : set it only for `anthropic-messages`
- `x-goog-api-key` : set it only for `gemini-generatecontent` ( stream `gemini-generatecontent` ) and `gemini-interactions`
- `Authorization: Bearer` : set it only for `openai-completions`
- using `x-api-key` from `/v1/messages` as `Authorization: Bearer` for `openai-completions` upstream
- using `x-goog-api-key` from `/v1beta/models/{model}:` and `/v1/interactions` as `Authorization: Bearer` for `openai-completions` upstream
- If there are config keys in proxy_config.toml for specific models category, override client headers for `anthropic-messages` or `gemini-generatecontent` upstream accordingly
- Never override client headers for the default `openai-completions` upstream

## Summary

✅ **Refactoring **

### Changes Made

1. **Handler**: Created `src/handlers/claude.ts` for anthropic-messages Claude API pass-through
2. **Router**: Modified `src/index.ts` to support `gemini-*` and `openai-completions` modes
3. **Types**: Added new config variables to `src/types/shared.ts`
4. **Config**: Modified `wrangler.toml` and `src/server.ts` with new variables

### Handler Matrix

| Endpoint | Mode | Handler | Target Upstream | Endpoint Input | Endpoint Ouput |
|----------|------|---------|-----------------|----------------|----------------|
| `/v1/messages` | anthropic-messages | claude.ts | Claude API | Claude Format | Claude Format |
| `/v1/messages` | openai-completions | messages.ts | OpenAI upstream | Claude Format | Claude Format |
| `/v1/interactions` | gemini-interactions | gemini.ts | Gemini API | Gemini interactions Format | Gemini interactions Format |
| `/v1/interactions` | openai-completions | openai.ts | OpenAI upstream | Gemini interactions Format | Gemini interactions Format |
| `/v1beta/models/{model}:` | gemini-generatecontent | gemini.ts | Gemini API | Gemini content Format | Gemini content Format |
| `/v1beta/models/{model}:` | openai-completions | openai.ts | OpenAI upstream | Gemini content Format | Gemini content Format |
| `/responses` | openai-responses | responses.ts | OpenAI Responses API | Responses API Format | Responses API Format |
| `/responses` | openai-completions | responses.ts | OpenAI Chat Completions | Responses API Format | Chat Completions Format |

### Type Safety

✅ All code passes TypeScript type checking (only pre-existing messages.ts errors remain)
