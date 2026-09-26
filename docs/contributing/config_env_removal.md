# Configuration Refactor: Remove ENV Variables

**Date**: 2026-02-28  
**Status**: ✅ Complete

## Summary

Removed `FIXED_ROUTE_TARGET_URL` and `FIXED_ROUTE_PATH_PREFIX` environment variables. All non-specific models now follow the `[models.default]` section and `[upstream]` defaults in `proxy_config.toml`.

## Changes Made

### 1. Updated `src/index.ts`

**parseFixedRoute function:**
- Added `proxyConfig` parameter
- Reads from `[models.default]` or `[upstream]` instead of ENV variables
- Added type guard for `defaultCategory` to handle union type

**Health check endpoint:**
- Updated to use `proxyConfig` instead of `env.FIXED_ROUTE_TARGET_URL`

### 2. Updated `src/utils/config-loader.ts`

**getModelRouteConfig function:**
- Removed `env.FIXED_ROUTE_TARGET_URL` fallbacks
- Uses `[models.default]` config when model not found
- Added type guard for `defaultCategory`

**Fallback chain for unconfigured models:**
```
1. [models.default].upstream_mode
   ↓ (if missing)
2. [upstream].upstream_mode
   ↓ (if missing)
3. Hardcoded: "openai-completions"
```

**Base URL fallback:**
```
1. [models.default].base_url
   ↓ (if missing)
2. [upstream].default_base_url
   ↓ (if missing)
3. Hardcoded: "https://api.qnaigc.com"
```

### 3. Updated `src/types/shared.ts`

Removed from `Env` interface:
- `FIXED_ROUTE_TARGET_URL?: string;`
- `FIXED_ROUTE_PATH_PREFIX?: string;`

### 4. Updated `src/server.ts`

Removed from env object:
- `FIXED_ROUTE_TARGET_URL`
- `FIXED_ROUTE_PATH_PREFIX`

## Configuration Example

### Before (ENV-based)
```bash
# .env or wrangler.toml
FIXED_ROUTE_TARGET_URL=https://api.qnaigc.com
FIXED_ROUTE_PATH_PREFIX=/api
```

### After (Config-based)
```toml
# proxy_config.toml
[upstream]
default_base_url = "https://api.qnaigc.com"
default_api_key = "sk-default-key"
upstream_mode = "openai-completions"

[models.default]
# Optional: Override upstream defaults for unconfigured models
upstream_mode = "openai-completions"
base_url = "https://api.qnaigc.com"
api_key = "sk-default-key"

[models.gemini]
upstream_mode = "gemini-generatecontent"
base_url = "https://api.example.com"
api_key = "sk-gemini-key"
"gemini-2.5-flash" = ["", "", ""]
```

## Behavior

### Configured Models
Models explicitly listed in any `[models.*]` category use their category's configuration.

### Unconfigured Models
Models **not** explicitly configured follow this priority:

1. **[models.default]** section (if exists)
   - `upstream_mode`, `base_url`, `api_key`
2. **[upstream]** section (fallback)
   - `upstream_mode`, `default_base_url`, `default_api_key`
3. **Hardcoded defaults** (last resort)
   - `upstream_mode = "openai-completions"`
   - `base_url = "https://api.qnaigc.com"`

## Migration Guide

If you were using ENV variables:

1. **Move settings to `proxy_config.toml`:**
   ```toml
   [upstream]
   default_base_url = "<your-FIXED_ROUTE_TARGET_URL>"
   default_api_key = "<your-api-key>"
   upstream_mode = "openai-completions"
   ```

2. **Optional: Add `[models.default]` for explicit control:**
   ```toml
   [models.default]
   upstream_mode = "openai-completions"
   base_url = "https://api.qnaigc.com"
   api_key = "sk-default-key"
   ```

3. **Remove from ENV/wrangler.toml:**
   - Delete `FIXED_ROUTE_TARGET_URL`
   - Delete `FIXED_ROUTE_PATH_PREFIX`

## Testing

Build successful:
```bash
npm run build
# ✅ dist/index.js and dist/server.js created
```

Type checking:
```bash
npm run typecheck
# ✅ No errors related to FIXED_ROUTE_* variables
# ⚠️  Pre-existing token-counting module warnings remain
```

## Benefits

1. **Single source of truth**: All configuration in `proxy_config.toml`
2. **Clearer hierarchy**: `[models.default]` → `[upstream]` → hardcoded
3. **No ENV pollution**: Fewer environment variables to manage
4. **Better defaults**: Explicit `[models.default]` section for unconfigured models
5. **Consistent behavior**: Same config structure for all models

## Breaking Changes

⚠️ **ENV variables no longer supported:**
- `FIXED_ROUTE_TARGET_URL` - Use `[upstream].default_base_url` or `[models.default].base_url`
- `FIXED_ROUTE_PATH_PREFIX` - No longer supported (was rarely used)

## Next Steps

1. Update documentation (README.md, routing_refactor.md)
2. Update test scripts to use new config structure
3. Test with existing proxy_config.toml
4. Verify all endpoints work with unconfigured models
