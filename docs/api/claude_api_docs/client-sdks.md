# Client SDKs

## Overview

Anthropic provides official SDKs that simplify API integration by handling authentication, request formatting, error handling, and more. These SDKs are available for multiple programming languages and provide a more convenient way to interact with the Claude API.

## Benefits

- **Automatic header management**: Handles x-api-key, anthropic-version, content-type headers
- **Type-safe request and response handling**: Compile-time type checking
- **Built-in retry logic and error handling**: Automatic retries for transient failures
- **Streaming support**: Easy-to-use streaming interfaces
- **Request timeouts and connection management**: Configurable timeouts and connection pools
- **Environment variable support**: Automatic API key loading from environment

## Available SDKs

### Official SDKs:

1. **Python** (`anthropic` package)
2. **JavaScript/TypeScript** (`@anthropic-ai/sdk` package)
3. **Java** (`com.anthropic` package)
4. **Go** (`github.com/anthropics/anthropic-sdk-go`)
5. **C#** (`Anthropic.SDK` package)
6. **Ruby** (`anthropic` gem)
7. **PHP** (`anthropic-php` package)

### Community SDKs:

- **Rust** (`anthropic-rs`)
- **Swift** (`AnthropicKit`)
- **Kotlin** (`anthropic-kotlin`)
- **Other languages**: Check community repositories

## Installation

### Python
```bash
pip install anthropic
```

### JavaScript/TypeScript
```bash
npm install @anthropic-ai/sdk
# or
yarn add @anthropic-ai/sdk
```

### Java
```xml
<dependency>
    <groupId>com.anthropic</groupId>
    <artifactId>anthropic-sdk</artifactId>
    <version>LATEST_VERSION</version>
</dependency>
```

### Go
```bash
go get github.com/anthropics/anthropic-sdk-go
```

### C#
```bash
dotnet add package Anthropic.SDK
```

### Ruby
```bash
gem install anthropic
```

### PHP
```bash
composer require anthropic-php/anthropic-php
```

## Basic Usage Examples

### Python
```python
from anthropic import Anthropic

# Initialize client (reads ANTHROPIC_API_KEY from environment)
client = Anthropic()

# Or explicitly provide API key
client = Anthropic(api_key="your-api-key-here")

# Send a message
response = client.messages.create(
    model="claude-sonnet-4-5-20250929",
    max_tokens=1024,
    messages=[
        {"role": "user", "content": "Hello, Claude"}
    ]
)

print(response.content[0].text)
```

### JavaScript/TypeScript
```javascript
import Anthropic from '@anthropic-ai/sdk';

// Initialize client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Send a message
const message = await anthropic.messages.create({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 1024,
  messages: [
    { role: 'user', content: 'Hello, Claude' }
  ],
});

console.log(message.content[0].text);
```

### Java
```java
import com.anthropic.Anthropic;
import com.anthropic.models.*;

public class Example {
    public static void main(String[] args) {
        Anthropic client = Anthropic.builder()
            .apiKey(System.getenv("ANTHROPIC_API_KEY"))
            .build();

        MessageCreateRequest request = MessageCreateRequest.builder()
            .model("claude-sonnet-4-5-20250929")
            .maxTokens(1024)
            .messages(List.of(
                MessageParam.builder()
                    .role(MessageRole.USER)
                    .content("Hello, Claude")
                    .build()
            ))
            .build();

        Message response = client.messages().create(request);
        System.out.println(response.getContent().get(0).getText());
    }
}
```

### Go
```go
package main

import (
    "context"
    "fmt"
    "os"

    anthropic "github.com/anthropics/anthropic-sdk-go"
)

func main() {
    client := anthropic.NewClient(os.Getenv("ANTHROPIC_API_KEY"))

    ctx := context.Background()
    req := anthropic.MessageRequest{
        Model: "claude-sonnet-4-5-20250929",
        MaxTokens: 1024,
        Messages: []anthropic.Message{
            {
                Role:    "user",
                Content: "Hello, Claude",
            },
        },
    }

    resp, err := client.CreateMessage(ctx, req)
    if err != nil {
        panic(err)
    }

    fmt.Println(resp.Content[0].Text)
}
```

## Advanced Features

### Streaming

#### Python
```python
from anthropic import Anthropic

client = Anthropic()

stream = client.messages.stream(
    model="claude-sonnet-4-5-20250929",
    max_tokens=1024,
    messages=[
        {"role": "user", "content": "Tell me a story"}
    ]
)

for event in stream:
    if event.type == "content_block_delta":
        print(event.delta.text, end="", flush=True)
```

#### JavaScript
```javascript
const stream = await anthropic.messages.stream({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 1024,
  messages: [
    { role: 'user', content: 'Tell me a story' }
  ],
});

for await (const event of stream) {
  if (event.type === 'content_block_delta') {
    process.stdout.write(event.delta.text);
  }
}
```

### Tool Use

#### Python
```python
response = client.messages.create(
    model="claude-sonnet-4-5-20250929",
    max_tokens=1024,
    messages=[
        {"role": "user", "content": "What's the weather in San Francisco?"}
    ],
    tools=[
        {
            "name": "get_weather",
            "description": "Get current weather for a location",
            "input_schema": {
                "type": "object",
                "properties": {
                    "location": {
                        "type": "string",
                        "description": "City name or coordinates"
                    }
                },
                "required": ["location"]
            }
        }
    ]
)

# Check for tool use
for content in response.content:
    if content.type == "tool_use":
        print(f"Tool: {content.name}")
        print(f"Input: {content.input}")
```

### File Uploads (Beta)

#### Python
```python
import requests

# Upload file
files_url = "https://api.anthropic.com/v1/files"
headers = {
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "files-api-2025-04-14",
    "x-api-key": client.api_key
}

with open("document.pdf", "rb") as f:
    files = {"file": f}
    response = requests.post(files_url, headers=headers, files=files)
    file_id = response.json()["id"]

# Use file in message
message_response = client.messages.create(
    model="claude-sonnet-4-5-20250929",
    max_tokens=1024,
    messages=[
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Summarize this document:"},
                {
                    "type": "document",
                    "source": {
                        "type": "file",
                        "file_id": file_id
                    }
                }
            ]
        }
    ]
)
```

## Configuration Options

### Common Configuration

#### Python
```python
client = Anthropic(
    api_key="your-api-key",

    # Timeout settings
    timeout=30.0,
    max_retries=2,

    # HTTP client configuration
    http_client=CustomHTTPClient(),

    # Custom headers
    default_headers={
        "X-Custom-Header": "value"
    },

    # Base URL (for testing/proxies)
    base_url="https://api.anthropic.com",

    # Automatic retry configuration
    max_retry_attempts=3,
    retry_multiplier=2.0,
    retry_max_delay=60.0,
)
```

#### JavaScript
```javascript
const anthropic = new Anthropic({
  apiKey: 'your-api-key',

  // Timeout settings
  timeout: 30 * 1000, // 30 seconds
  maxRetries: 2,

  // Base URL
  baseURL: 'https://api.anthropic.com',

  // HTTP agent
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true }),

  // Custom headers
  defaultHeaders: {
    'X-Custom-Header': 'value'
  },
});
```

### Environment Variables

All SDKs support reading the API key from environment variables:

| SDK | Environment Variable | Default |
|-----|---------------------|---------|
| Python | `ANTHROPIC_API_KEY` | Required |
| JavaScript | `ANTHROPIC_API_KEY` | Required |
| Java | `ANTHROPIC_API_KEY` | Required |
| Go | `ANTHROPIC_API_KEY` | Required |
| C# | `ANTHROPIC_API_KEY` | Required |
| Ruby | `ANTHROPIC_API_KEY` | Required |
| PHP | `ANTHROPIC_API_KEY` | Required |

## Error Handling

### SDK-Specific Errors

#### Python
```python
from anthropic import Anthropic, APIError, RateLimitError

client = Anthropic()

try:
    response = client.messages.create(
        model="claude-sonnet-4-5-20250929",
        max_tokens=1024,
        messages=[{"role": "user", "content": "Hello"}]
    )
except RateLimitError as e:
    print(f"Rate limited: {e}")
    print(f"Retry after: {e.retry_after} seconds")
except APIError as e:
    print(f"API error: {e.type} - {e.message}")
    print(f"Status code: {e.status_code}")
except Exception as e:
    print(f"Unexpected error: {e}")
```

#### JavaScript
```javascript
try {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello' }]
  });
} catch (error) {
  if (error instanceof anthropic.RateLimitError) {
    console.log(`Rate limited: ${error.message}`);
    console.log(`Retry after: ${error.retryAfter} seconds`);
  } else if (error instanceof anthropic.APIError) {
    console.log(`API error: ${error.type} - ${error.message}`);
    console.log(`Status code: ${error.status}`);
  } else {
    console.log(`Unexpected error: ${error}`);
  }
}
```

### Retry Logic

All SDKs include built-in retry logic for transient failures:

- **429 Rate Limit Errors**: Automatic retry with exponential backoff
- **5xx Server Errors**: Automatic retry for server errors
- **Network Errors**: Automatic retry for connection issues
- **Timeout Errors**: Configurable retry behavior

## Best Practices

### 1. Environment Configuration
- Store API keys in environment variables, not in code
- Use different keys for different environments (development, staging, production)
- Rotate keys regularly for security

### 2. Error Handling
- Implement comprehensive error handling
- Use retry logic for transient failures
- Log errors appropriately for debugging
- Monitor for rate limit errors and adjust usage patterns

### 3. Performance
- Use connection pooling for HTTP clients
- Implement timeouts appropriate for your use case
- Batch requests when possible to reduce overhead
- Monitor SDK performance and update versions

### 4. Maintenance
- Keep SDK versions up to date
- Monitor for deprecation notices
- Test new SDK versions before upgrading production
- Review changelogs for breaking changes

## Version Compatibility

### SDK Versioning
- **Major versions**: May contain breaking changes
- **Minor versions**: Add features, maintain compatibility
- **Patch versions**: Bug fixes and improvements

### API Version Compatibility
- SDKs automatically use compatible API versions
- You can override the API version if needed
- Check SDK documentation for supported API versions

## Migration Between SDK Versions

### Example: Python 0.x to 1.x
```python
# Old version (0.x)
import anthropic
client = anthropic.Client(api_key="...")

# New version (1.x)
from anthropic import Anthropic
client = Anthropic(api_key="...")
```

### Check Migration Guides
- Review SDK changelogs before upgrading
- Test in staging environments first
- Update code incrementally if possible
- Use automated tests to verify compatibility

## Community and Support

### Official Resources
- **Documentation**: [Anthropic API Docs](https://docs.anthropic.com)
- **GitHub Repositories**: Check Anthropic organization on GitHub
- **Support**: Contact through Anthropic Console or support channels

### Community Resources
- **Stack Overflow**: Tag questions with `anthropic` or `claude-api`
- **Discord/Slack**: Developer communities
- **Blogs and Tutorials**: Community-written guides

## Troubleshooting

### Common Issues

#### 1. Authentication Errors
- Check API key is set correctly
- Verify environment variable name matches SDK expectations
- Ensure key has appropriate permissions

#### 2. Rate Limiting
- Monitor rate limit headers
- Implement exponential backoff
- Consider using batch API for large volumes

#### 3. Network Issues
- Check firewall and proxy settings
- Verify DNS resolution
- Monitor connection timeouts

#### 4. SDK-specific Issues
- Check SDK version compatibility
- Review SDK documentation
- Look for known issues in GitHub repository

### Getting Help
1. **Check documentation** first
2. **Search existing issues** on GitHub
3. **Create reproducible examples** when reporting issues
4. **Include SDK version** and error details

## Next Steps

- [API Overview](overview.md): Understanding the Claude API
- [Examples](../examples/): More code samples and tutorials
- [Rate Limits](rate-limits.md): Understanding usage limits
- [Authentication](authentication.md): Setting up authentication

## Additional Resources

- [Anthropic API Documentation](https://docs.anthropic.com)
- [GitHub Repository](https://github.com/anthropics)
- [Community Forums](https://community.anthropic.com)
- [API Reference](https://platform.claude.com/docs/api)