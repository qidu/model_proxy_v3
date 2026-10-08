# Multiple Upstream Support Analysis

**Date**: 2026-02-25  
**Status**: ⚠️ Partially Implemented

## Current Implementation

### What's Working ✅

1. **Single Model → Single Upstream**
   - Each model can be configured with one upstream
   - Config file: `proxy_config.toml`
   - Example:
   ```toml
   [models.deepseek-v3-1]
   mode = "openai-completions"
   base_url = "https://api.qnaigc.com"  # Single upstream
   api_key = "sk-xxx"
   ```

2. **Default Upstream**
   - All unconfigured models use default upstream
   - Example:
   ```toml
   [upstream]
   default_url = "https://api.qnaigc.com"
   default_api_key = "sk-xxx"
   ```

3. **Mode-based Routing**
   - `native` mode: Direct pass-through to native API
   - `openai-completions` mode: Convert to OpenAI format
   - Works per-model basis

### What's NOT Implemented ❌

1. **Single Model → Multiple Upstreams**
   - Documented in `routing_refactor.md` but NOT implemented
   - Example from docs (NOT working):
   ```toml
   MODELS_UPSTREAM_MAPPING = '{
     "deepseek-v3.1": [
       {"https://api.deepseek.com": 50, "api-schema": "openai-completions"},
       {"https://api.qnaigc.com": 50, "api-schema": "openai-completions"}
     ]
   }'
   ```

2. **Load Balancing / Ratio-based Distribution**
   - No implementation for distributing requests across multiple upstreams
   - No ratio/weight support (e.g., 50/50 split)

3. **Failover Support**
   - No automatic failover to backup upstream
   - No health checking

## Gap Analysis

### Code Review

1. **Config Loader** (`src/utils/config-loader.ts`):
   ```typescript
   interface ProxyConfig {
     models?: Record<string, {
       mode?: 'native' | 'openai-completions';
       base_url?: string;  // ❌ Only single URL
       api_key?: string;
     }>;
   }
   ```
   - Only supports single `base_url` per model
   - No array of upstreams

2. **Main Router** (`src/index.ts`):
   - Loads `proxyConfig` but doesn't use it for routing
   - Uses `env.FIXED_ROUTE_TARGET_URL` for all models
   - No per-model upstream selection

3. **Handlers** (`src/handlers/messages.ts`):
   - Receives `targetUrl` as parameter
   - No logic to select from multiple upstreams
   - No load balancing logic

### Documentation vs Implementation

| Feature | Documented | Implemented | Gap |
|---------|-----------|-------------|-----|
| Single upstream per model | ✅ | ✅ | None |
| Multiple upstreams per model | ✅ | ❌ | **HIGH** |
| Ratio-based distribution | ✅ | ❌ | **HIGH** |
| Default upstream | ✅ | ✅ | None |
| Mode-based routing | ✅ | ✅ | None |

## Recommendations

### Option 1: Remove Documentation (Quick Fix)
- Remove `MODELS_UPSTREAM_MAPPING` example from `routing_refactor.md`
- Update docs to reflect current single-upstream implementation
- **Pros**: No code changes, accurate documentation
- **Cons**: Loses future feature documentation

### Option 2: Implement Multiple Upstream Support (Full Feature)

#### 2.1 Update Config Schema
```toml
# proxy_config.toml
[models.deepseek-v3-1]
mode = "openai-completions"

# Multiple upstreams with weights
[[models.deepseek-v3-1.upstreams]]
base_url = "https://api.deepseek.com"
api_key = "sk-xxx"
weight = 50

[[models.deepseek-v3-1.upstreams]]
base_url = "https://api.qnaigc.com"
api_key = "sk-yyy"
weight = 50
```

#### 2.2 Update ProxyConfig Interface
```typescript
interface ProxyConfig {
  models?: Record<string, {
    mode?: 'native' | 'openai-completions';
    base_url?: string;  // Single upstream (backward compatible)
    api_key?: string;
    upstreams?: Array<{  // Multiple upstreams (new)
      base_url: string;
      api_key?: string;
      weight: number;
    }>;
  }>;
}
```

#### 2.3 Add Upstream Selection Logic
```typescript
// src/utils/upstream-selector.ts
export function selectUpstream(
  config: ModelConfig,
  requestId: string
): { url: string; apiKey?: string } {
  // Single upstream (backward compatible)
  if (config.base_url) {
    return { url: config.base_url, apiKey: config.api_key };
  }
  
  // Multiple upstreams - weighted random selection
  if (config.upstreams && config.upstreams.length > 0) {
    const totalWeight = config.upstreams.reduce((sum, u) => sum + u.weight, 0);
    let random = Math.random() * totalWeight;
    
    for (const upstream of config.upstreams) {
      random -= upstream.weight;
      if (random <= 0) {
        return { url: upstream.base_url, apiKey: upstream.api_key };
      }
    }
  }
  
  throw new Error('No upstream configured');
}
```

#### 2.4 Update Main Router
```typescript
// src/index.ts
const proxyConfig = await loadProxyConfig(env);
const modelConfig = getModelConfig(proxyConfig, modelName);

if (modelConfig) {
  // Select upstream based on config
  const { url, apiKey } = selectUpstream(modelConfig, requestId);
  targetUrl = url;
  if (apiKey) {
    authHeaders['Authorization'] = `Bearer ${apiKey}`;
  }
}
```

#### 2.5 Implementation Effort
- **Time**: 2-4 hours
- **Files to modify**: 4 files
  - `src/utils/config-loader.ts` - Update types
  - `src/utils/upstream-selector.ts` - New file
  - `src/index.ts` - Use upstream selector
  - `proxy_config.toml` - Add examples
- **Testing**: Test with 2+ upstreams per model

### Option 3: Hybrid Approach (Recommended)
1. **Phase 1** (Now): Update documentation to match current implementation
2. **Phase 2** (Future): Implement multiple upstream support when needed

## Proposed Actions

### Immediate (Phase 1)
1. ✅ Update `routing_refactor.md`:
   - Mark `MODELS_UPSTREAM_MAPPING` as "Future Feature"
   - Document current single-upstream implementation
   - Add examples to `proxy_config.toml`

2. ✅ Update `proxy_config.toml`:
   - Add more single-upstream examples
   - Show different modes (native vs openai-completions)
   - Document per-model API key override

### Future (Phase 2)
1. ❌ Implement multiple upstream support (when needed)
2. ❌ Add load balancing strategies (round-robin, weighted, random)
3. ❌ Add failover support
4. ❌ Add health checking

## Example Config Updates

### Current Working Config
```toml
[upstream]
default_url = "https://api.qnaigc.com"
default_api_key = "sk-default-key"

# Single upstream per model
[models.deepseek-v3-1]
mode = "openai-completions"
base_url = "https://api.deepseek.com"
api_key = "sk-deepseek-key"

[models.gemini-2-5-flash]
mode = "native"
base_url = "https://api.example1.com"
api_key = "sk-gemini-key"

[defaults]
mode = "openai-completions"
```

### Future Multiple Upstream Config (NOT IMPLEMENTED)
```toml
# This is a FUTURE feature - NOT currently supported
[models.deepseek-v3-1]
mode = "openai-completions"

[[models.deepseek-v3-1.upstreams]]
base_url = "https://api.deepseek.com"
api_key = "sk-deepseek-key"
weight = 50

[[models.deepseek-v3-1.upstreams]]
base_url = "https://api.qnaigc.com"
api_key = "sk-qnaigc-key"
weight = 50
```

## Conclusion

**Current Status**: The proxy supports **single upstream per model** only.

**Recommendation**: Update documentation to match implementation (Option 3 - Phase 1).

**Future Work**: Implement multiple upstream support when there's a real use case for load balancing or failover.
