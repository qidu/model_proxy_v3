# Claude API Documentation

## Overview

The Claude API is a RESTful API at `https://api.anthropic.com` that provides programmatic access to Claude models. The primary API is the Messages API (`POST /v1/messages`) for conversational interactions.

## Table of Contents

1. [API Overview](overview.md)
2. [Authentication](authentication.md)
3. [Messages API](messages-api.md)
4. [Message Batches API](batches-api.md)
5. [Token Counting API](token-counting-api.md)
6. [Models API](models-api.md)
7. [Files API](files-api.md)
8. [Skills API](skills-api.md)
9. [API Versioning](versioning.md)
10. [Rate Limits](rate-limits.md)
11. [Client SDKs](client-sdks.md)
12. [Examples](examples/)

## Quick Start

### Prerequisites
- An [Anthropic Console account](https://platform.claude.com)
- An [API key](/settings/keys)

### Basic Example

```bash
curl https://api.anthropic.com/v1/messages \
  --header "x-api-key: $ANTHROPIC_API_KEY" \
  --header "anthropic-version: 2023-06-01" \
  --header "content-type: application/json" \
  --data '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Hello, Claude"}
    ]
  }'
```

## Available APIs

### General Availability
- **Messages API**: Send messages to Claude for conversational interactions (`POST /v1/messages`)
- **Message Batches API**: Process large volumes of Messages requests asynchronously with 50% cost reduction (`POST /v1/messages/batches`)
- **Token Counting API**: Count tokens in a message before sending to manage costs and rate limits (`POST /v1/messages/count_tokens`)
- **Models API**: List available Claude models and their details (`GET /v1/models`)

### Beta Features
- **Files API**: Upload and manage files for use across multiple API calls (`POST /v1/files`, `GET /v1/files`)
- **Skills API**: Create and manage custom agent skills (`POST /v1/skills`, `GET /v1/skills`)

## Authentication

All requests to the Claude API must include these headers:
- `x-api-key`: Your API key from Console
- `anthropic-version`: API version (e.g., `2023-06-01`)
- `content-type`: `application/json`

## Base URL
```
https://api.anthropic.com
```

## Next Steps
- Read the [API Overview](overview.md) for detailed information
- Check [Authentication](authentication.md) for setup instructions
- Explore [Examples](examples/) for code samples in multiple languages