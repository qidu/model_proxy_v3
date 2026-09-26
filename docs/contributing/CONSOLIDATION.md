# Test Scripts Consolidation

**Date**: 2026-02-27

## Summary

Merged 27 test scripts into 6 comprehensive test suites for better maintainability.

## Merged Test Scripts

### 1. `test_claude.sh` ← 10 scripts
Merged from:
- test_claude_haiku_4_5.sh
- test_claude_haiku_both_modes.sh
- test_claude_haiku_with_alias.sh
- test_claude_opus_both_modes.sh
- test_claude_sonnet_4_5.sh
- test_claude_sonnet_both_modes.sh
- test_claude_sonnet_config.sh
- test_claude_sonnet_native.sh

**Coverage:**
- Claude models: claude-4.6-sonnet, claude-4.5-opus, claude-4.1-sonnet, claude-haiku-4-5
- Both modes: anthropic-messages (native) and openai-completions
- All endpoints: /v1/messages (native), /v1/interactions, generateContent (OpenAI mode)

### 2. `test_gemini.sh` ← 9 scripts
Merged from:
- test_gemini_2_0_flash.sh
- test_gemini3_models.sh
- test_gemini3_quick.sh
- test_gemini_all_endpoints.sh
- test_gemini_both_modes.sh
- test_gemini_endpoints.sh
- test_gemini_model_alias.sh
- test_gemini_sse_both_modes.sh
- test_gemini_streamgeneratecontent.sh

**Coverage:**
- Gemini models: gemini-3.1-pro-preview, gemini-3.0-flash-preview, gemini-2.5-flash
- Both modes: gemini-generatecontent (native) and openai-completions
- All endpoints: /v1/messages, /v1/interactions, generateContent
- Model alias support

### 3. `test_thinking.sh` ← 3 scripts
Merged from:
- test_thinking_models.sh
- test_thinking_models_all.sh
- test_thinking_models_stream.sh

**Coverage:**
- 10 thinking models from DeepSeek, Qwen, Doubao, Moonshot
- Both non-streaming and streaming tests
- All 3 endpoints: /v1/messages, /v1/interactions, generateContent/streamGenerateContent
- Complex reasoning questions for streaming tests

### 4. `test_streaming.sh` ← 3 scripts
Merged from:
- test_sse_streaming.sh
- test_streamgeneratecontent.sh
- test_streamgeneratecontent_both_modes.sh

**Coverage:**
- SSE streaming validation across multiple models
- All streaming endpoints: /v1/messages, /v1/interactions, streamGenerateContent
- Event format validation (event: and data: lines)

### 5. `test_deepseek.sh` ← 3 scripts
Merged from:
- test_deepseek_models.sh
- test_deepseek_r1.sh
- test_deepseek_v3_2.sh

**Coverage:**
- 4 DeepSeek models: v3.2, r1-0528, v3.2-exp-thinking, v3.1-terminus-thinking
- All 3 endpoints: /v1/messages, /v1/interactions, generateContent

### 6. `test_all.sh` ← 2 scripts
Merged from:
- test_all_from_keys.sh
- test_all_models.sh

**Coverage:**
- Dynamic model list fetching from /v1/models endpoint
- Tests first 30 models from the list
- Both non-streaming and streaming tests
- Success rate calculation

## Benefits

1. **Reduced file count**: 27 → 6 scripts (77% reduction)
2. **Better organization**: Grouped by model provider/feature
3. **Consistent structure**: All scripts use same test functions
4. **Easier maintenance**: Single file per test category
5. **Comprehensive coverage**: Each script tests multiple scenarios

## Usage

```bash
# Test specific provider
./tests/test_claude.sh
./tests/test_gemini.sh
./tests/test_deepseek.sh

# Test specific feature
./tests/test_thinking.sh
./tests/test_streaming.sh

# Test all available models
./tests/test_all.sh
```

## Configuration Reference

All tests use `proxy_config.toml` with the following structure:

```toml
[upstream]
default_base_url = "https://api.qnaigc.com"
default_api_key = "sk-..."

[models.claude]
upstream_mode = "anthropic-messages"
base_url = "https://api.wenwen-ai.com"
api_key = "sk-..."
"claude-4.6-sonnet" = ["claude-opus-4-1-20250805-thinking", "", ""]

[models.gemini]
upstream_mode = "gemini-generatecontent"
base_url = "https://api.yoosheen.com"
api_key = "sk-..."
"gemini-3.1-pro-preview" = ["", "", ""]

[models.default]
upstream_mode = "openai-completions"
```

## Old Scripts

The original 27 test scripts are preserved in the repository for reference but should be considered deprecated in favor of the 6 consolidated scripts.
