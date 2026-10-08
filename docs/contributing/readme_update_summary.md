# README Update Summary

**Date**: 2026-02-27  
**Status**: ✅ Complete

## Changes Made

Updated README.md to reflect the revised routing logic and configuration structure from the 2026-02-27 revision.

### Sections Updated

#### 1. Quick Start - Configuration (Line ~50)
**Before**: Flat structure with normalized model names
```toml
[models.gemini-2-5-flash]
mode = "native"
```

**After**: Category-based structure with original names
```toml
[models.gemini]
upstream_mode = "gemini-generatecontent"
"gemini-2.5-flash" = ["", "", ""]
```

**Key Changes**:
- Removed model name normalization explanation
- Added category-based structure
- Changed `mode` to `upstream_mode`
- Added array format documentation
- Added inheritance chain explanation

#### 2. Quick Start - Testing (Line ~120)
**Before**: Generic test commands
```bash
bash tests/test_models.sh
```

**After**: Consolidated test scripts
```bash
./tests/test_claude.sh
./tests/test_gemini.sh
./tests/test_deepseek.sh
./tests/test_thinking.sh
./tests/test_streaming.sh
./tests/test_all.sh
```

**Key Changes**:
- Updated to use consolidated test scripts from CONSOLIDATION.md
- Added reference to test_guideline.md

#### 3. Quick Start - Documentation (Line ~130)
**Added**:
- `../architecture/routing_config_revision.md` - Latest config structure revision
- `tests/test_guideline.md` - Testing guide
- `tests/CONSOLIDATION.md` - Consolidated test scripts

#### 4. Configuration - Model Configuration (Line ~300)
**Before**: Flat structure examples
```toml
[models.gemini-2-5-flash]
mode = "native"
[models.deepseek-v3-1]
mode = "openai-completions"
```

**After**: Category-based examples
```toml
[models.gemini]
upstream_mode = "gemini-generatecontent"
"gemini-2.5-flash" = ["", "", ""]

[models.claude]
upstream_mode = "anthropic-messages"
"claude-4.6-sonnet" = ["claude-opus-4-1-20250805-thinking", "", ""]

[models.default]
upstream_mode = "openai-completions"
"deepseek/deepseek-v3.2" = ["", "", ""]
```

**Key Changes**:
- Category-based structure throughout
- Array format with inheritance
- Explicit upstream_mode values
- No model name normalization

#### 5. Test Results (Line ~430)
**Added**: Revision note at the top
```markdown
**Latest Revision (2026-02-27):** ✅ Config Structure Updated

The routing logic and configuration structure have been revised:
- Category-based config with inheritance
- Array format with empty string inheritance
- Explicit upstream_mode values
- No normalization of model names

See `../architecture/routing_config_revision.md` for complete details.
```

#### 6. Features Validated (Line ~520)
**Updated**:
- Removed: "Model name normalization"
- Removed: "Native mode detection - Auto-detects Claude vs Gemini models"
- Added: "Category-based config - Models grouped by provider with inheritance"
- Added: "upstream_mode detection - Explicit mode per category"
- Added: "Config inheritance - Model → Category → Upstream defaults"

## Configuration Structure Changes

### Old Structure (Deprecated)
```toml
[upstream]
default_url = "https://api.qnaigc.com"
default_api_key = "sk-..."

[models.gemini-2-5-flash]  # Normalized name
mode = "native"
base_url = "https://api.example.com"
api_key = "sk-gemini-key"

[models.deepseek-v3-1]  # Normalized name
mode = "openai-completions"

[defaults]
mode = "openai-completions"
```

**Issues**:
- Model names normalized (replaced `/` and `.` with `-`)
- Flat structure (one section per model)
- Generic `mode` field
- No inheritance

### New Structure (Current)
```toml
[upstream]
upstream_mode = "openai-completions"
default_base_url = "https://api.qnaigc.com"
default_api_key = "sk-..."

[models.gemini]  # Category
upstream_mode = "gemini-generatecontent"
base_url = "https://api.example.com"
api_key = "sk-gemini-key"
"gemini-2.5-flash" = ["", "", ""]  # Original name, array format

[models.claude]  # Category
upstream_mode = "anthropic-messages"
base_url = "https://api.anthropic.com"
api_key = "sk-claude-key"
"claude-4.6-sonnet" = ["claude-opus-4-1-20250805-thinking", "", ""]

[models.default]  # Fallback category
upstream_mode = "openai-completions"
"deepseek/deepseek-v3.2" = ["", "", ""]  # Original name with /
```

**Benefits**:
- Original model names preserved
- Category-based grouping
- Explicit `upstream_mode` per category
- Full inheritance chain
- Less duplication

## Key Concepts Documented

### 1. Category-Based Structure
Models are grouped into categories (`[models.gemini]`, `[models.claude]`, `[models.default]`) that share common settings.

### 2. Array Format
Each model uses a 3-element array: `["model-alias", "base-url", "api-key"]`
- Empty strings `""` inherit from category
- Non-empty values override category defaults

### 3. Upstream Modes
Explicit mode values per category:
- `anthropic-messages` - Native Claude API
- `gemini-generatecontent` - Native Gemini API
- `gemini-interactions` - Native Gemini Interactions API
- `openai-completions` - OpenAI-compatible format conversion

### 4. Inheritance Chain
```
Model array value → Category default → [upstream] default → Error
```

### 5. Model Names
No normalization applied - preserve original names:
- `"deepseek/deepseek-v3.2"` (with `/`)
- `"gemini-2.5-flash"` (with `.`)
- `"z-ai/glm-5"` (with `/`)

## Testing Updates

### Consolidated Test Scripts
Merged 27 test scripts into 6 comprehensive suites:
1. `test_claude.sh` - Claude models (both modes)
2. `test_gemini.sh` - Gemini models (both modes)
3. `test_deepseek.sh` - DeepSeek models
4. `test_thinking.sh` - Thinking/reasoning models
5. `test_streaming.sh` - SSE streaming validation
6. `test_all.sh` - All available models

### Test Configuration
All tests now use the category-based `proxy_config.toml` structure.

## Documentation References

Updated documentation links:
- `../architecture/routing_config_revision.md` - Complete revision details
- `tests/test_guideline.md` - Testing guide
- `tests/CONSOLIDATION.md` - Test script consolidation
- `../../getting-started/proxy_config.example.toml` - Configuration template

## Migration Notes

Users with existing configs need to:
1. Replace `mode` with `upstream_mode`
2. Use specific mode values (not generic "native")
3. Group models into categories
4. Use array format: `["alias", "url", "key"]`
5. Remove model name normalization (use original names)

See `../architecture/routing_config_revision.md` for detailed migration guide.

## Consistency Achieved

✅ README.md now fully aligned with:
- `../../getting-started/proxy_config.example.toml`
- `../architecture/routing_refactor.md`
- `../architecture/routing_config_revision.md`
- `src/utils/config-loader.ts` implementation
- `src/index.ts` routing logic

All documentation, configuration, and code now use the same structure and terminology.
