How to Send Your Request

  Option 1: Using Authorization Header (Bearer Token)

  curl -X POST "https://your-proxy.com/https/api.qnaigc.com/v1/messages" \
    -H "Authorization: Bearer YOUR_API_KEY_HERE" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "abc",
      "messages": [
        {"role": "user", "content": "Hello"}
      ],
      "max_tokens": 1000
    }'

  Option 2: Using x-api-key Header

  curl -X POST "https://your-proxy.com/https/api.qnaigc.com/v1/messages" \
    -H "x-api-key: YOUR_API_KEY_HERE" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "abc",
      "messages": [
        {"role": "user", "content": "Hello"}
      ],
      "max_tokens": 1000
    }'

  Option 3: Both Headers (if needed)

  curl -X POST "https://your-proxy.com/https/api.qnaigc.com/v1/messages" \
    -H "Authorization: Bearer YOUR_API_KEY_HERE" \
    -H "x-api-key: YOUR_API_KEY_HERE" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "abc",
      "messages": [
        {"role": "user", "content": "Hello"}
      ],
      "max_tokens": 1000
    }'

  Complete Request Flow

  Your Client → Claude Proxy v3 → Upstream API (api.qnaigc.com)
       ↓                              ↓
    POST /https/api.qnaigc.com/v1/messages
    Headers: Authorization: Bearer sk-xxx
    Body: {"model": "abc", "messages": [...]}
                                    ↓
                           POST https://api.qnaigc.com/v1/messages
                           Headers: Authorization: Bearer sk-xxx
                           Body: {"model": "abc", "messages": [...]}

  Key Points

  1. The proxy forwards headers exactly as received - no modification
  2. You must include model in request body when not in URL
  3. Supported auth methods:
    - Authorization: Bearer <token>
    - x-api-key: <key>
    - Both (if target API accepts)
  4. The proxy validates that at least one auth header exists
  5. Target API (api.qnaigc.com) must accept the authentication method you're using

  Example with Full Configuration

  Your configuration without modelId in URL:
  {
    targetConfig: {
      targetUrl: "https://api.qnaigc.com",
      targetPathPrefix: "/"
    },
    claudeEndpoint: "v1/messages"
    // No modelId field
  }

  Client request must include:
  - URL: /https/api.qnaigc.com/v1/messages (no abc segment)
  - Headers: Authorization: Bearer <key> or x-api-key: <key>
  - Body: Must contain "model": "abc"

  Resulting upstream call:
  - URL: https://api.qnaigc.com/v1/messages
  - Headers: Your auth headers forwarded
  - Body: Converted OpenAI format with model "abc"

