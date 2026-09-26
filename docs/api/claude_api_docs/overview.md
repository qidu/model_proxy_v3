# Claude API Overview

## Introduction

The Claude API is a RESTful API at `https://api.anthropic.com` that provides programmatic access to Claude models. The primary API is the Messages API (`POST /v1/messages`) for conversational interactions.

## Prerequisites

To use the Claude API, you'll need:

- An [Anthropic Console account](https://platform.claude.com)
- An [API key](/settings/keys)

## Available APIs

### General Availability:

**Messages API** (`/docs/en/api/messages`):
- **Endpoint**: `POST /v1/messages`
i- **Description**: Send messages to Claude for conversational interactions

**Message Batches API** (`/docs/en/api/creating-message-batches`):
- **Endpoint**: `POST /v1/messages/batches`
- **Description**: Process large volumes of Messages requests asynchronously with 50% cost reduction

**Token Counting API** (`/docs/en/api/messages-count-tokens`):
- **Endpoint**: `POST /v1/messages/count_tokens`
- **Description**: Count tokens in a message before sending to manage costs and rate limits

**Models API** (`/docs/en/api/models-list`):
- **Endpoint**: `GET /v1/models`
- **Description**: List available Claude models and their details

### Beta:

**Files API** (`/docs/en/api/files-create`):
- **Endpoint**: `POST /v1/files`, `GET /v1/files`
- **Description**: Upload and manage files for use across multiple API calls

**Skills API** (`/docs/en/api/skills/create-skill`):
- **Endpoint**: `POST /v1/skills`, `GET /v1/skills`
- **Description**: Create and manage custom agent skills

## Authentication

All requests to the Claude API must include these headers:

| Header | Value | Required |
|--------|-------|----------|
| `x-api-key` | Your API key from Console | Yes |
| `anthropic-version` | API version (e.g., `2023-06-01`) | Yes |
| `content-type` | `application/json` | Yes |

### Getting API Keys

The API is made available via the web [Console](https://platform.claude.com/). You can use the [Workbench](https://platform.claude.com/workbench) to try out the API in the browser and then generate API keys in [Account Settings](https://platform.claude.com/settings/keys). Use [workspaces](https://platform.claude.com/settings/workspaces) to segment your API keys and [control spend](/docs/en/api/rate-limits) by use case.

## Client SDKs

Anthropic provides official SDKs that simplify API integration by handling authentication, request formatting, error handling, and more.

**Benefits**:
- Automatic header management (x-api-key, anthropic-version, content-type)
- Type-safe request and response handling
- Built-in retry logic and error handling
- Streaming support
- Request timeouts and connection management

**Example** (Python):
```python
from anthropic import Anthropic

client = Anthropic()  # Reads ANTHROPIC_API_KEY from environment
message = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello, Claude"}]
)
```

For a list of client SDKs and their respective installation instructions, see [Client SDKs](/docs/en/api/client-sdks).

## Claude API vs Third-Party Platforms

Claude is available through Anthropic's direct API and through partner platforms. Choose based on your infrastructure, compliance requirements, and pricing preferences.

### Claude API

- **Direct access** to the latest models and features first
- **Anthropic billing and support**
- **Best for**: New integrations, full feature access, direct relationship with Anthropic

### Third-Party Platform APIs

Access Claude through AWS, Google Cloud, or Microsoft Azure:
- **Integrated** with cloud provider billing and IAM
- **May have feature delays** or differences from the direct API
- **Best for**: Existing cloud commitments, specific compliance requirements, consolidated cloud billing

| Platform | Provider | Documentation |
|----------|----------|---------------|
| Amazon Bedrock | AWS | [Claude on Amazon Bedrock](/docs/en/build-with-claude/claude-on-amazon-bedrock) |
| Vertex AI | Google Cloud | [Claude on Vertex AI](/docs/en/build-with-claude/claude-on-vertex-ai) |
| Azure AI | Microsoft Azure | [Claude on Azure AI](/docs/en/build-with-claude/claude-in-microsoft-foundry) |

**Note**: For feature availability across platforms, see the [Features overview](/docs/en/build-with-claude/overview).

## Request and Response Format

### Request Size Limits

The API has different maximum request sizes depending on the endpoint:

| Endpoint | Maximum Size |
|----------|--------------|
| Standard endpoints (Messages, Token Counting) | 32 MB |
| [Batch API](/docs/en/build-with-claude/batch-processing) | 256 MB |
| [Files API](/docs/en/build-with-claude/files) | 500 MB |

If you exceed these limits, you'll receive a 413 `request_too_large` error.

### Response Headers

The Claude API includes the following headers in every response:

- `request-id`: A globally unique identifier for the request
- `anthropic-organization-id`: The organization ID associated with the API key used in the request

## Rate Limits and Availability

### Rate Limits

The API enforces rate limits and spend limits to prevent misuse and manage capacity. Limits are organized into usage tiers that increase automatically as you use the API. Each tier has:

- **Spend limits**: Maximum monthly cost for API usage
- **Rate limits**: Maximum number of requests per minute (RPM) and tokens per minute (TPM)

You can view your organization's current limits in the [Console](/settings/limits). For higher limits or Priority Tier (enhanced service levels with committed spend), contact sales through the Console.

For detailed information about limits, tiers, and the token bucket algorithm used for rate limiting, see [Rate limits](/docs/en/api/rate-limits).

### Availability

The Claude API is available in [many countries and regions](/docs/en/api/supported-regions) worldwide. Check the supported regions page to confirm availability in your location.

## Basic Example

Here's a minimal request using the Messages API:

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

**Response:**
```json
{
  "id": "msg_01XFDUDYJgAACzvnptvVoYEL",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "Hello! How can I assist you today?"
    }
  ],
  "model": "claude-sonnet-4-5",
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 12,
    "output_tokens": 8
  }
}
```

## Next Steps

- **Get started**: Prerequisites, step-by-step tutorial, and examples in multiple languages
- **Working with Messages**: Request/response patterns, multi-turn conversations, and best practices
- **Messages API Reference**: Complete API specification: parameters, responses, and error codes
- **Client SDKs**: Installation guides for Python, TypeScript, Java, Go, C#, Ruby, and PHP
- **Features overview**: Explore capabilities: caching, vision, tool use, streaming, and more
- **Rate limits**: Usage tiers, spend limits, and rate limiting with token bucket algorithm