# Claude API Reference

**Source:** https://docs.anthropic.com/claude/reference/

## Quick Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/messages` | POST | Send a message to Claude |
| `/v1/messages-streaming` | POST | Streaming message response |
| `/v1/complete` | POST | Legacy completion |
| `/v1/models` | GET | List available models |

## Authentication

```
Authorization: Bearer ANTHROPIC_API_KEY
x-api-key: ANTHROPIC_API_KEY
```

## Send Message (Non-Streaming)

```bash
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Hello, Claude"}
    ]
  }'
```

## Send Message (Streaming)

```bash
curl https://api.anthropic.com/v1/messages-streaming \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Hello, Claude"}
    ]
  }'
```

## Request Body

```json
{
  "model": "string",
  "max_tokens": integer,
  "system": "string",
  "messages": [
    {
      "role": "user" | "assistant" | "developer",
      "content": "string"
    }
  ],
  "temperature": number,
  "top_p": number,
  "top_k": number,
  "stop_sequences": ["string"],
  "stream": boolean
}
```

## Response

```json
{
  "id": "msg_...",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "..."
    }
  ],
  "model": "claude-sonnet-4-20250514",
  "stop_reason": "end_turn" | "max_tokens",
  "usage": {
    "input_tokens": integer,
    "output_tokens": integer
  }
}
```

## Models

- `claude-opus-4-20250514`
- `claude-sonnet-4-20250514`
- `claude-haiku-4-20250514`
- `claude-3-5-sonnet-20241022`
- `claude-3-opus-20240229`
- `claude-3-haiku-20240307`

---

*Captured: 2026-02-28*
*Source: https://docs.anthropic.com/claude/reference/*