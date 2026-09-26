## Testing Guide
### Routing Architecture and requirements
```
# DO NOT WRITE
read docs/routing_refactor.md
```
### Routing config template
```
# DO NOT WRITE
read proxy_config.toml_template
```

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

## Testing Configuration Reference

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

## Notice
```
# remove keys in test scripts
source .git_audit_before_commiting
```
