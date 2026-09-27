# Filter text models
lynx -accept_all_cookies -crawl -dump https://openrouter.ai/api/v1/models | jq '.data.[] | select(.architecture.modality == "text->text")'

# Filter text models and shows only ID
lynx -accept_all_cookies -crawl -dump https://openrouter.ai/api/v1/models | jq '.data.[] | select(.architecture.modality == "text->text") | .id'

# Filter text and context length
lynx -accept_all_cookies -crawl -dump https://openrouter.ai/api/v1/models | jq '.data.[] | select(.architecture.modality == "text->text" ) | select(.context_length > 120000)'
