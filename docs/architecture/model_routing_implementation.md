# Model-Specific Routing Implementation

**Date**: 2026-02-25  
**Status**: ✅ Implemented and Tested

## Overview

Implemented model-specific routing that allows each model to use different upstreams, API keys, and modes based on configuration in `proxy_config.toml`.

## Changes Made

### 1. Config Loader (`src/utils/config-loader.ts`)

Added `getModelRouteConfig()` function:
- Resolves model-specific routing configuration
- Normalizes model names (replaces `/` and `.` with `-`)
- Falls back to default upstream if model not configured
- Returns `{ targetUrl, apiKey, mode }`

```typescript
export function getModelRouteConfig(
  modelName: string,
  proxyConfig: ProxyConfig,
  env: Env
): ModelRouteConfig
```

### 2. Main Router (`src/index.ts`)

Integrated model-specific routing:
- Extracts model name from request body for `/v1/messages`
- Looks up model config using `getModelRouteConfig()`
- Overrides auth headers if model has specific API key
- Builds target URL based on mode (native vs openai-completions)
- Logs routing decisions for debugging

Key changes:
- Parse request body early to extract model name
- Use model-specific `targetUrl` and `apiKey`
- Pass `modelAuthHeaders` to handlers instead of generic `authHeaders`

### 3. Messages Handler (`src/handlers/messages.ts`)

Fixed pre-existing bugs:
- Removed broken `convertOpenAIToClaudeChunk` code
- Fixed variable declaration order (`targetModelId` before use)
- Fixed type casting for `ClaudeMessagesRequest`
- Fixed `convertClaudeToOpenAIRequest` call signature

## Configuration Example

```toml
[upstream]
default_url = "https://api.qnaigc.com"
default_api_key = "sk-default-key"

# Model with custom upstream (native mode)
[models.gemini-2-5-flash]
mode = "native"
base_url = "https://api.example1.com"
api_key = "sk-gemini-key"

# Model using default upstream
[models.deepseek-v3-1]
mode = "openai-completions"
# Uses default_url and default_api_key

[defaults]
mode = "openai-completions"
```

## Test Results

All tests passing (see `tests/test_model_routing.sh`):

✅ **Gemini (gemini-2.5-flash)**
- Uses custom upstream: `https://api.example1.com`
- Mode: `native`
- Custom API key works
- Complex questions work

✅ **MiniMax (minimax/minimax-m2.1)**
- Uses default upstream: `https://api.qnaigc.com`
- Mode: `openai-completions`
- Default API key works

✅ **DeepSeek (deepseek-v3.1)**
- Uses default upstream: `https://api.qnaigc.com`
- Mode: `openai-completions`
- Default API key works

## How It Works

1. **Request arrives** at `/v1/messages` with model name in body
2. **Extract model name** from request body (e.g., `gemini-2.5-flash`)
3. **Normalize model name** (e.g., `gemini-2-5-flash`)
4. **Look up config** in `proxyConfig.models[normalizedModel]`
5. **Resolve routing**:
   - If model config exists: use `base_url`, `api_key`, `mode` from config
   - If not: use `default_url`, `default_api_key` from `[upstream]`
6. **Build target URL**:
   - Native mode: `{base_url}/v1/messages`
   - OpenAI-completions mode: `{base_url}/v1/chat/completions`
7. **Override auth headers** if model has specific API key
8. **Route to handler** with model-specific config

## Benefits

- ✅ Each model can use different upstream APIs
- ✅ Per-model API keys for security
- ✅ Mode-based routing (native vs openai-completions)
- ✅ Fallback to default upstream for unconfigured models
- ✅ No code changes needed to add new models (just config)

## Future Enhancements

- Multiple upstreams per model (load balancing)
- Health checking and automatic failover
- Weighted distribution across upstreams
- Per-model timeout and retry configuration

## Files Modified

1. `src/utils/config-loader.ts` - Added `getModelRouteConfig()`
2. `src/index.ts` - Integrated model-specific routing
3. `src/handlers/messages.ts` - Fixed pre-existing bugs
4. `proxy_config.toml` - Updated with examples
5. `tests/test_model_routing.sh` - New comprehensive test script

## Testing

```bash
# Run routing tests
bash tests/test_model_routing.sh

# Test specific model
curl http://localhost:8788/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 100
  }'
```
