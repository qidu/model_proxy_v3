#!/usr/bin/env bash
set -euo pipefail

PROXY_URL="http://127.0.0.1:8777"
API_KEY="fake-test-key"

echo "=== Tool Judge Decision API Tests ==="
echo "Proxy: $PROXY_URL"
echo ""

# Test 1: Choice mode - single tool
echo "--- Test 1: Choice mode (single tool) ---"
curl -s -X POST "$PROXY_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "code-small",
    "messages": [
      {"role": "user", "content": "What is the weather in Tokyo?"}
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "Get current weather",
          "parameters": {"type": "object", "properties": {"location": {"type": "string"}}, "required": ["location"]}
        }
      }
    ]
  }' | jq '.choices[0].message.tool_calls[0].function.name // "no tool called"'
echo ""

# Test 2: Choice mode - multiple tools (should pick one)
echo "--- Test 2: Choice mode (multiple tools) ---"
curl -s -X POST "$PROXY_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "code-small",
    "messages": [
      {"role": "user", "content": "Calculate 2+2 and get the weather in Tokyo"}
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "calculator",
          "description": "Perform basic math",
          "parameters": {"type": "object", "properties": {"expression": {"type": "string"}}, "required": ["expression"]}
        }
      },
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "Get current weather",
          "parameters": {"type": "object", "properties": {"location": {"type": "string"}}, "required": ["location"]}
        }
      }
    ]
  }' | jq '.choices[0].message.tool_calls[0].function.name // "no tool called"'
echo ""

# Test 3: NouL mode - no tools needed
echo "--- Test 3: NouL mode (no tools needed) ---"
curl -s -X POST "$PROXY_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "code-small",
    "messages": [
      {"role": "user", "content": "Hello, how are you?"}
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "Get current weather",
          "parameters": {"type": "object", "properties": {"location": {"type": "string"}}, "required": ["location"]}
        }
      }
    ]
  }' | jq '.choices[0].message.tool_calls // "no tool called (empty array)"'
echo ""

# Test 4: No tools provided
echo "--- Test 4: No tools provided ---"
curl -s -X POST "$PROXY_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "code-small",
    "messages": [
      {"role": "user", "content": "What is 2+2?"}
    ]
  }' | jq '.choices[0].message.content'
echo ""

# Test 5: Test with specific model alias that uses decision API
echo "--- Test 5: Direct decision model (if configured) ---"
curl -s -X POST "$PROXY_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "code-small",
    "messages": [
      {"role": "user", "content": "Search for latest news"}
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "search_web",
          "description": "Search the web",
          "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}
        }
      }
    ]
  }' | jq '.choices[0].message.tool_calls[0].function.name // "no tool called"'
echo ""

echo "=== All tests completed ==="
