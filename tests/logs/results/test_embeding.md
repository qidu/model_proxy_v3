# Embeding models Example

## Embedding API
API Endpoint at
```
/v1/embeddings
```
config section for upstream
```
[models.embedding]
#base_url = "https://api.qnaigc.com"
#base_url = "https://openrouter.ai/api"
#api_key = "sk-17ac71ed56aee29*"
```

## Emdebding Request
Note: "input" also supports batch processing with arrays: ["text1", "text2", "text3"]
```bash
curl https://openrouter.ai/api/v1/embeddings \
  -H "Authorization: Bearer sk-or-v1-6cdb535c****" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen/qwen3-embedding-4b",
    "input": "Your text string goes here",
    "encoding_format": "float"
  }'
```

## Embedding Response
Note: ignore `provider` when outputing
```json
{"object":"list","data":[{"object":"embedding","embedding":[0.00013645895523950458,0.0018074032850563526,0.00838635116815567,0.0166570283472538],"index":0}],"model":"Qwen/Qwen3-Embedding-4B","usage":{"prompt_tokens":6,"total_tokens":6,"cost":1.2e-7},"provider":"DeepInfra","id":"gen-emb-1779328942-BSxYnh40JOckaI7e4lV8"}

```
