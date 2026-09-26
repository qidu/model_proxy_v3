# Google Gemini API Reference

**Source:** https://ai.google.dev/gemini-api/docs

## Quick Reference

| Category | Endpoints |
|----------|-----------|
| **Text Generation** | `/v1beta/models/{model}:generateContent` |
| **Streaming** | `/v1beta/models/{model}:streamGenerateContent` |
| **Embeddings** | `/v1beta/models/{model}:embedContent` |
| **Count Tokens** | `/v1beta/models/{model}:countTokens` |

## Authentication

```bash
# Via API Key (Google AI Studio)
curl -H "x-goog-api-key: $GOOGLE_API_KEY" ...

# Via OAuth (Vertex AI)
gcloud auth application-default print-access-token
```

## Text Generation (Google AI)

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=$GOOGLE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{
      "parts": [{"text": "Explain quantum computing in 2 sentences."}]
    }],
    "generationConfig": {
      "temperature": 0.9,
      "maxOutputTokens": 256
    }
  }'
```

## Request Body

```json
{
  "contents": [
    {
      "role": "user" | "model",
      "parts": [
        {
          "text": "string"
        },
        {
          "inlineData": {
            "mimeType": "image/jpeg",
            "data": "base64-encoded-data"
          }
        }
      ]
    }
  ],
  "systemInstruction": {
    "parts": [{"text": "You are a helpful assistant."}]
  },
  "generationConfig": {
    "temperature": number,
    "topP": number,
    "topK": number,
    "maxOutputTokens": integer,
    "stopSequences": ["string"]
  },
  "tools": [
    {
      "functionDeclarations": [...]
    }
  ],
  "safetySettings": [
    {
      "category": "HARM_CATEGORY_*",
      "threshold": "BLOCK_*"
    }
  ]
}
```

## Response

```json
{
  "candidates": [
    {
      "content": {
        "role": "model",
        "parts": [{"text": "..."}]
      },
      "finishReason": "STOP" | "MAX_TOKENS" | "SAFETY" | "RECITATION",
      "safetyRatings": [
        {
          "category": "HARM_CATEGORY_HARASSMENT",
          "probability": "NEGLIGIBLE" | "LOW" | "MEDIUM" | "HIGH"
        }
      ]
    }
  ],
  "usageMetadata": {
    "promptTokenCount": integer,
    "candidatesTokenCount": integer,
    "totalTokenCount": integer
  }
}
```

## Models

### Gemini 3 Series
- `gemini-2.5-pro-preview-06-05` - Latest Pro with thinking
- `gemini-2.5-flash-preview-05-20` - Latest Flash
- `gemini-3.0-pro` - Gemini 3 Pro
- `gemini-3.0-flash` - Gemini 3 Flash

### Gemini 2 Series
- `gemini-2.0-flash-exp` - Experimental Flash
- `gemini-2.0-pro-exp` - Experimental Pro

### Gemini 1.5 Series
- `gemini-1.5-pro` - Pro with 2M context
- `gemini-1.5-flash` - Fast with 1M context
- `gemini-1.5-flash-8b` - Lightweight

### Image Generation (Imagen)
- `imagen-3-generate-002` - Latest Imagen

### Video Generation (Veo)
- `veo-3.1` - Video generation with audio

### Audio Generation
- `gemini-2.5-pro-tts` - Text-to-speech

## Features

### Vision (Image Input)
```bash
curl ".../generateContent?key=$API_KEY" \
  -d '{
    "contents": [{
      "parts": [
        {"text": "What is in this image?"},
        {"inlineData": {"mimeType": "image/jpeg", "data": "BASE64..."}}
      ]
    }]
  }'
```

### Function Calling
```json
{
  "tools": [{
    "functionDeclarations": [{
      "name": "get_weather",
      "description": "Get weather for a location",
      "parameters": {
        "type": "object",
        "properties": {
          "location": {"type": "string"}
        },
        "required": ["location"]
      }
    }]
  }]
}
```

### Structured Output
```json
{
  "generationConfig": {
    "responseMimeType": "application/json",
    "responseSchema": {
      "type": "object",
      "properties": {
        "name": {"type": "string"},
        "age": {"type": "integer"}
      }
    }
  }
}
```

### Context Caching
```bash
# Cache long context for cost savings
curl ".../generateContent?key=$API_KEY" \
  -d '{
    "contents": [...],
    "cachedContent": "cached-content-name"
  }'
```

### Live API (Real-time)
```bash
# WebSocket for real-time voice
wss://generativelanguage.googleapis.com/ws/googleai/genai/v1beta/models/gemini-2.0-flash-exp:streamGenerateContent?key=$API_KEY
```

## Rate Limits

| Tier | Requests/min | Tokens/min |
|------|-------------|------------|
| Free | 15 | 1M |
| Tier 1 | 60 | 4M |
| Tier 2 | 120 | 8M |

## Pricing (Google AI Studio)

| Model | Input | Output |
|-------|-------|--------|
| Gemini 2.5 Pro | $1.25-2.50/M | $10-15/M |
| Gemini 2.5 Flash | $0.10-0.30/M | $0.70-2.10/M |
| Gemini 1.5 Pro | $1.25/M | $5.00/M |
| Gemini 1.5 Flash | $0.075/M | $0.30/M |

---

*Captured: 2026-02-28*
*Source: https://ai.google.dev/gemini-api/docs*