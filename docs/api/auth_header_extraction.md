# API Key Extraction from Request Headers

**Date**: 2026-03-02  
**Status**: ✅ Complete

## Overview

Refactored authentication handling to extract API keys from request headers and transform them to the correct format for each upstream mode, instead of reading from config file.

## Changes Made

### 1. New Utility Function: `transformAuthHeadersForUpstream()`

**Location**: `src/utils/routing.ts`

Extracts API key from request headers with endpoint-specific priority and formats it correctly based on upstream mode:

```typescript
function transformAuthHeadersForUpstream(
  request: Request,
  upstreamMode: string,
  endpointPath?: string
): Record<string, string>
```

**Endpoint-Specific API Key Extraction Priority**:

For `/v1/messages`:
1. `x-api-key` header (preferred)
2. `x-goog-api-key` header (fallback)
3. `Authorization: Bearer <token>` header (fallback)

For `/v1/interactions` and `/v1beta/models/{model}:*`:
1. `x-goog-api-key` header (preferred)
2. `x-api-key` header (fallback)
3. `Authorization: Bearer <token>` header (fallback)

**Header Transformation by Upstream Mode**:

| Upstream Mode | Output Header | Format |
|---------------|---------------|--------|
| `anthropic-messages` | `x-api-key` | Raw API key |
| `gemini-generatecontent` | `x-goog-api-key` | Raw API key |
| `gemini-interactions` | `x-goog-api-key` | Raw API key |
| `openai-completions` | `Authorization` | `Bearer <api-key>` |

### 2. Updated Main Router (`src/index.ts`)

**Removed**: Config-based API key logic (50+ lines of conditional code)

**Added**: Single line transformation call with endpoint path:
```typescript
modelAuthHeaders = transformAuthHeadersForUpstream(request, modelRoute.upstreamMode, path);
```

**Applied to**:
- Model-specific routing (when model is found in config)
- Fixed routing (default routing without model-specific config)

**Endpoint path parameter**: Enables endpoint-specific header priority (e.g., `/v1/messages` prefers `x-api-key`)

### 3. Fixed 'native' Mode References

**Changed**: All `upstreamMode = 'native'` assignments to use specific mode names:
- `upstreamMode = modelRoute.upstreamMode` (preserves actual mode)

**Updated**: `parseFixedRoute()` return type:
- From: `upstreamMode?: 'native' | 'openai-completions'`
- To: `upstreamMode?: string`

**Updated**: Handler routing checks:
- From: `if (upstreamMode === 'native')`
- To: `if (upstreamMode === 'anthropic-messages')` or `if (upstreamMode === 'gemini-generatecontent' || upstreamMode === 'gemini-interactions')`

## Authentication Flow

### Endpoint-Specific Header Priority

The proxy respects endpoint-specific header preferences as defined in the routing documentation:

**`/v1/messages` endpoint:**
1. `x-api-key` (preferred)
2. `x-goog-api-key` (fallback)
3. `Authorization: Bearer` (fallback)

**`/v1/interactions` and `/v1beta/models/{model}:*` endpoints:**
1. `x-goog-api-key` (preferred)
2. `x-api-key` (fallback)
3. `Authorization: Bearer` (fallback)

### Header Transformation Flow

```
Request → Extract API key (endpoint-specific priority) → Determine upstream mode
  → Transform to correct header format → Send to upstream
```

**Example 1: `/v1/messages` with Claude upstream**
```
Client: x-api-key: sk-test-123
  ↓ (extract with /v1/messages priority)
Proxy: Detects anthropic-messages mode
  ↓ (transform)
Upstream: x-api-key: sk-test-123
```

**Example 2: `/v1/interactions` with Gemini upstream**
```
Client: x-goog-api-key: test-key-456
  ↓ (extract with Gemini endpoint priority)
Proxy: Detects gemini-interactions mode
  ↓ (transform)
Upstream: x-goog-api-key: test-key-456
```

**Example 3: `/v1/messages` with OpenAI upstream**
```
Client: x-api-key: sk-test-789
  ↓ (extract with /v1/messages priority)
Proxy: Detects openai-completions mode
  ↓ (transform)
Upstream: Authorization: Bearer sk-test-789
```

## Upstream Mode Mapping

### Valid Upstream Modes

1. **`anthropic-messages`**: Native Claude API
   - Endpoint: `/v1/messages`
   - Auth header: `x-api-key: <key>`

2. **`gemini-generatecontent`**: Native Gemini API (generateContent)
   - Endpoint: `/v1beta/models/{model}:generateContent`
   - Auth header: `x-goog-api-key: <key>`

3. **`gemini-interactions`**: Native Gemini API (interactions)
   - Endpoint: `/v1/interactions`
   - Auth header: `x-goog-api-key: <key>`

4. **`openai-completions`**: OpenAI-compatible API
   - Endpoint: `/v1/chat/completions`
   - Auth header: `Authorization: Bearer <key>`

### Deprecated Mode

- **`native`**: No longer used as a mode value
  - Previously used as generic "native mode" indicator
  - Now replaced with specific mode names above

## Testing

### Type Checking
```bash
npm run typecheck
```
✅ All type checks pass

### Manual Testing Required

Test each upstream mode with different header formats:

```bash
# Test anthropic-messages mode
curl -X POST http://localhost:8788/v1/messages \
  -H "x-api-key: sk-test-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-4.5-sonnet", "messages": [{"role": "user", "content": "test"}], "max_tokens": 10}'

# Test gemini-generatecontent mode
curl -X POST http://localhost:8788/v1beta/models/gemini-2.5-flash:generateContent \
  -H "x-goog-api-key: test-key" \
  -H "Content-Type: application/json" \
  -d '{"contents": [{"role": "user", "parts": [{"text": "test"}]}]}'

# Test openai-completions mode
curl -X POST http://localhost:8788/v1/messages \
  -H "Authorization: Bearer sk-test-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "deepseek/deepseek-v3.2", "messages": [{"role": "user", "content": "test"}], "max_tokens": 10}'
```

## Configuration Impact

### Config File Changes

**Before**: Config file contained API keys
```toml
[models.claude]
upstream_mode = "anthropic-messages"
base_url = "https://api.anthropic.com"
api_key = "sk-secret-key-here"  # ❌ Stored in config
```

**After**: Config file only has routing info
```toml
[models.claude]
upstream_mode = "anthropic-messages"
base_url = "https://api.anthropic.com"
# api_key removed - now from request headers only
```

**Note**: The `api_key` field in config is now ignored. All API keys must come from request headers.

## Security Improvements

1. **No secrets in config files**: API keys only in request headers
2. **Clear separation**: Config = routing, Headers = authentication
3. **Flexible key management**: Different keys per request without config changes
4. **Audit trail**: API keys visible in request logs (if enabled)

## Backward Compatibility

### Breaking Changes

- ⚠️ Config file `api_key` fields are now ignored
- ⚠️ All requests must include API key in headers

### Migration Guide

**Old behavior**: API key in config file
```toml
[models.claude]
api_key = "sk-secret-key"
```

**New behavior**: API key in request header
```bash
curl -H "x-api-key: sk-secret-key" ...
```

## Related Documentation

- `../architecture/routing_refactor.md` - Routing architecture
- `../architecture/routing_config_revision.md` - Config structure
- `../../README.md` - API authentication section

## Summary

✅ **Completed**:
- API key extraction from request headers
- Header transformation per upstream mode
- Removed config-based API key logic
- Fixed all 'native' mode references
- Type checking passes

✅ **Benefits**:
- Cleaner code (50+ lines removed)
- Better security (no secrets in config)
- More flexible (per-request keys)
- Simpler logic (mode-based transformation)
