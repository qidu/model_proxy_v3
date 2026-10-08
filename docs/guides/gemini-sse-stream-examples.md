# Gemini SSE Stream Examples

**Created:** March 1, 2026
**Source:** OpenClaw conversation analysis

---

## Key Differences

| Aspect | Standard API | Proxy Endpoint | Interactions API |
|--------|--------------|----------------|------------------|
| **Endpoint** | `/v1beta/models/{model}:generateContent` | `/v1beta/models/{model}:generateContent` | `/v1beta/interactions` |
| **Input Field** | `contents[]` | `contents[]` | `input` |
| **Multi-turn** | Manual message array | Manual message array | `Turn[]` support |
| **Streaming** | `streamGenerateContent` | `streamGenerateContent` | `stream: true` in request |

---

## 1. Context Structure

### Standard & Proxy

```json
{
  "contents": [
    {
      "role": "user" | "model",
      "parts": [
        {"text": "..."},
        {"inlineData": {"mimeType": "image/jpeg", "data": "BASE64..."}}
      ]
    }
  ]
}
```

### Interactions API (new)

```json
{
  "input": Content | Content[] | Turn[] | "string"
}
```

Where `Turn` supports multi-turn conversations.

---

## 2. Parts Structure

Same across all endpoints:

```json
{
  "parts": [
    {"text": "Hello!"},                           // Text
    {"inlineData": {"mimeType": "image/jpeg", "data": "BASE64..."}},  // Image
    {"fileData": {"mimeType": "audio/mp3", "fileUri": "gs://..."}}    // Audio/Video
  ]
}
```

---

## 3. SSE Streaming Examples

### 3.1 Standard Gemini API Streaming

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?key=$API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{"parts": [{"text": "Tell me a short story about a robot."}]}]
  }'
```

**Raw SSE Response:**

```
data: {
  "candidates": [
    {
      "content": {
        "role": "model",
        "parts": [{"text": "O"}]
      },
      "finishReason": "STOP"
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 11,
    "candidatesTokenCount": 1,
    "totalTokenCount": 12
  }
}

data: {
  "candidates": [
    {
      "content": {
        "role": "model",
        "parts": [{"text": "n"}]
      },
      "finishReason": "STOP"
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 11,
    "candidatesTokenCount": 2,
    "totalTokenCount": 13
  }
}

data: {
  "candidates": [
    {
      "content": {
        "role": "model",
        "parts": [{"text": "ce"}]
      },
      "finishReason": "STOP"
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 11,
    "candidatesTokenCount": 3,
    "totalTokenCount": 14
  }
}

... (multiple chunks)

data: [DONE]
```

### 3.2 Interactions API with Streaming

```bash
curl -X POST "https://generativelanguage.googleapis.com/v1beta/interactions" \
  -H "x-goog-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-1.5-flash",
    "input": "Write a haiku about sunrise.",
    "stream": true
  }'
```

**Raw SSE Response:**

```
data: {"interactionId":"abc123","state":"IN_PROGRESS"}

data: {"state":"IN_PROGRESS","result":{"content":[{"role":"model","parts":[{"text":"G"}]}]}}

data: {"state":"IN_PROGRESS","result":{"content":[{"role":"model","parts":[{"text":"olden"}]}]}}

data: {"state":"IN_PROGRESS","result":{"content":[{"role":"model","parts":[{"text":" ray"}]}]}}

data: {"state":"IN_PROGRESS","result":{"content":[{"role":"model","parts":[{"text":"s pierce"}]}]}}

data: {"state":"COMPLETED","result":{"content":[{"role":"model","parts":[{"text":"Golden rays pierce the dark, awakening the world below."}]}],"usageMetadata":{"promptTokenCount":7,"responseTokenCount":14,"totalTokenCount":21}},"turnCount":1}
```

### 3.3 JSON Mode Streaming

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?key=$API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{"parts": [{"text": "Return a JSON object with name and age"}]}],
    "generationConfig": {
      "responseMimeType": "application/json",
      "responseSchema": {
        "type": "object",
        "properties": {
          "name": {"type": "string"},
          "city": {"type": "string"}
        }
      }
    }
  }'
```

**Raw SSE Response:**

```
data: {"candidates":[{"content":{"role":"model","parts":[{"text":"\"name"}]},"finishReason":"STOP"}]}

data: {"candidates":[{"content":{"role":"model","parts":[{"text":"\":\""}]},"finishReason":"STOP"}]}

data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Alice"}]},"finishReason":"STOP"}]}

data: {"candidates":[{"content":{"role":"model","parts":[{"text":"\",\""}]},"finishReason":"STOP"}]}

data: {"candidates":[{"content":{"role":"model","parts":[{"text":"city"}]},"finishReason":"STOP"}]}

data: {"candidates":[{"content":{"role":"model","parts":[{"text":"\":\""}]},"finishReason":"STOP"}]}

data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Paris"}]},"finishReason":"STOP"}]}

data: {"candidates":[{"content":{"role":"model","parts":[{"text":"\"}"}],"finishReason":"STOP"}]}

data: {"candidates":[{"content":{"role":"model","parts":[{"text":"}"}],"finishReason":"STOP"}]}

data: [DONE]
```

### 3.4 Multi-modal Streaming (Image + Text)

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?key=$API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{
      "parts": [
        {"text": "What do you see in this image?"},
        {"inlineData": {"mimeType": "image/jpeg", "data": "BASE64_IMAGE_DATA"}}
      ]
    }]
  }'
```

**Raw SSE Response:**

```
data: {"candidates":[{"content":{"role":"model","parts":[{"text":"I"}]},"finishReason":"STOP"}]}

data: {"candidates":[{"content":{"role":"model","parts":[{"text":" see"}]},"finishReason":"STOP"}]}

data: {"candidates":[{"content":{"role":"model","parts":[{"text":" a"}]},"finishReason":"STOP"}]}

data: {"candidates":[{"content":{"role":"model","parts":[{"text":" sun"}]},"finishReason":"STOP"}]}

data: {"candidates":[{"content":{"role":"model","parts":[{"text":"set"}]},"finishReason":"STOP"}]}

data: {"candidates":[{"content":{"role":"model","parts":[{"text":" over"}]},"finishReason":"STOP"}]}

data: {"candidates":[{"content":{"role":"model","parts":[{"text":" the"}]},"finishReason":"STOP"}]}

data: {"candidates":[{"content":{"role":"model","parts":[{"text":" ocean"}]},"finishReason":"STOP"}]}

data: [DONE]
```

---

## 4. Key Observations

| Pattern | Description |
|---------|-------------|
| **Chunking** | Each word/character sent as separate `data:` event |
| **Accumulation** | Client must accumulate chunks for complete response |
| **`[DONE]`** | Signals end of stream |
| **Token counts** | Updated in each chunk |
| **finishReason** | `STOP` for normal completion, `MAX_TOKENS` if truncated |
| **Timing** | Chunks arrive based on model output speed |

---

## 5. SSE Parsing Pattern (JavaScript)

```javascript
const response = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  
  const chunk = decoder.decode(value);
  const lines = chunk.split('\n');
  
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = line.slice(6);
      if (data === '[DONE]') {
        console.log('Stream complete');
        return;
      }
      const parsed = JSON.parse(data);
      const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
      process.stdout.write(text); // Stream to stdout
    }
  }
}
```

---

## 6. Proxy Endpoint Simplification

The proxy removes project/location prefix:

### Path

| | Standard Vertex AI | Proxy Endpoint |
|---|---|---|
| **Full Path** | `/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent` | `/v1beta/models/{model}:generateContent` |

### Auth

| | Standard Vertex AI | Proxy Endpoint |
|---|---|---|
| **Method** | GCP OAuth | API Key or OAuth |

Same `contents` and `parts` structure - just shorter path!

---

## Summary

| API Type | Streaming Method | Key Features |
|----------|-----------------|--------------|
| **Standard** | `streamGenerateContent` | Raw JSON chunks, `data:` prefix |
| **Proxy** | `streamGenerateContent` | Same as Standard, shorter path |
| **Interactions** | `stream: true` | Adds `interactionId` and `state` fields |
| **JSON Mode** | `streamGenerateContent` | Character-by-character chunks |
| **Multi-modal** | `streamGenerateContent` | Same streaming with `inlineData` in `parts` |

---

*Generated: March 1, 2026*
*Source: OpenClaw Claude analysis*
