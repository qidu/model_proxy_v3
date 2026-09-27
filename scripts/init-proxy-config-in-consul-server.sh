# Readme
## Refer to docs/consul-server.md
## Refer to consul section in README.md
## Refer to config at ./proxy_config.toml

# upstream
consul kv put model-proxy-v3/upstream/default_base_url "https://api.qnaigc.com"
consul kv put model-proxy-v3/upstream/budget_to_effort_low "8000"
consul kv put model-proxy-v3/upstream/budget_to_effort_medium "20000"
consul kv put model-proxy-v3/upstream/budget_to_effort_high "0"

# models.claude
consul kv put model-proxy-v3/models/claude/upstream_mode "anthropic-messages"
consul kv put model-proxy-v3/models/claude/base_url "http://localhost:4000"
consul kv put model-proxy-v3/models/claude/api_key "sk-17ac71ed56aee29*"
consul kv put model-proxy-v3/models/claude/claude-opus-4-6 '["claude-opus-4-6", "", ""]'
consul kv put model-proxy-v3/models/claude/claude-sonnet-4-6 '["claude-sonnet-4-6", "", ""]'
consul kv put model-proxy-v3/models/claude/claude-sonnet-4-5 '["claude-sonnet-4-5", "", ""]'
consul kv put model-proxy-v3/models/claude/claude-haiku-4-5 '["claude-haiku-4-5", "", ""]'

# models.free
consul kv put model-proxy-v3/models/free/upstream_mode "openai-completions"
consul kv put model-proxy-v3/models/free/base_url "http://localhost:4000"
consul kv put model-proxy-v3/models/free/api_key "sk-hello"
consul kv put model-proxy-v3/models/free/gpt-5.4-mini '["gpt-5.4-mini", "", ""]'
consul kv put model-proxy-v3/models/free/gpt-5-4-mini '["gpt-5.4-mini", "", ""]'
consul kv put model-proxy-v3/models/free/gemini-3-flash '["gemini-3-flash", "", ""]'
consul kv put model-proxy-v3/models/free/gpt-oss-120b-medium '["gpt-oss-120b-medium", "", ""]'
consul kv put model-proxy-v3/models/free/gemini-3.1-pro-low '["gemini-3.1-pro-low", "", ""]'
consul kv put model-proxy-v3/models/free/gemini-3.1-pro-high '["gemini-3.1-pro-high", "", ""]'

# models.gemini
consul kv put model-proxy-v3/models/gemini/upstream_mode "gemini-generatecontent"
consul kv put model-proxy-v3/models/gemini/base_url "https://api.example.com"
consul kv put model-proxy-v3/models/gemini/api_key "sk-***"
consul kv put model-proxy-v3/models/gemini/gemini-3.0-flash-preview '["gemini-3-flash-preview", "", ""]'

# models.default
consul kv put model-proxy-v3/models/default/llama '["llama3.1-8B", "sdk://localhost", ""]'
