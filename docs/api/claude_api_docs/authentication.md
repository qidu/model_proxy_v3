# Authentication

## Overview

All requests to the Claude API must be authenticated using API keys. The API uses a simple header-based authentication system.

## Required Headers

Every API request must include these headers:

| Header | Value | Required | Description |
|--------|-------|----------|-------------|
| `x-api-key` | Your API key | Yes | Your secret API key from the Anthropic Console |
| `anthropic-version` | API version (e.g., `2023-06-01`) | Yes | Specifies which API version to use |
| `content-type` | `application/json` | Yes | Content type for request body |

## Getting API Keys

### Step 1: Create an Anthropic Console Account

1. Visit [https://platform.claude.com](https://platform.claude.com)
2. Sign up for an account
3. Verify your email address

### Step 2: Generate API Keys

1. Log into the [Anthropic Console](https://platform.claude.com)
2. Navigate to **Settings** → **API Keys**
3. Click **"Create API Key"**
4. Provide a name for the key (e.g., "Production", "Development")
5. Click **"Create"**
6. **Copy and save the key** - you won't be able to see it again!

### Step 3: Manage API Keys

- **View keys**: See all your API keys with their creation dates and last used dates
- **Delete keys**: Revoke access by deleting keys when no longer needed
- **Regenerate**: If a key is compromised, delete it and create a new one

## API Key Security Best Practices

### Do:
- Store API keys in environment variables
- Use different keys for different environments (development, staging, production)
- Rotate keys periodically
- Use the principle of least privilege
- Monitor API key usage in the Console

### Don't:
- Commit API keys to version control (git)
- Share API keys publicly
- Use the same key across multiple applications
- Hardcode keys in source files

## Environment Variable Example

### Unix/Linux/macOS:
```bash
export ANTHROPIC_API_KEY='your-api-key-here'
```

### Windows (Command Prompt):
```cmd
set ANTHROPIC_API_KEY=your-api-key-here
```

### Windows (PowerShell):
```powershell
$env:ANTHROPIC_API_KEY='your-api-key-here'
```

## Example Request with Authentication

### cURL:
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

### Python (with SDK):
```python
from anthropic import Anthropic

# Key is automatically read from ANTHROPIC_API_KEY environment variable
client = Anthropic()

# Or explicitly provide the key
client = Anthropic(api_key="your-api-key-here")

response = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello, Claude"}]
)
```

## Authentication Errors

### Common Error Responses:

| HTTP Status | Error Code | Description |
|-------------|------------|-------------|
| 401 | `invalid_api_key` | The provided API key is invalid |
| 401 | `authentication_error` | Authentication failed |
| 403 | `access_denied` | API key doesn't have permission for this resource |
| 429 | `rate_limit_exceeded` | Too many requests |

### Example Error Response:
```json
{
  "type": "error",
  "error": {
    "type": "invalid_api_key",
    "message": "Invalid API key"
  }
}
```

## API Versioning

The `anthropic-version` header is required for all requests. This ensures backward compatibility as the API evolves.

### Current Versions:
- `2023-06-01` (Recommended)
- `2023-01-01` (Initial release, deprecated)

### Version History:
- **2023-06-01**: New streaming format, removed legacy fields
- **2023-01-01**: Initial API release

## Workspaces and Access Control

### Workspaces:
Workspaces allow you to segment API keys and control spend by use case:

1. **Create workspaces** for different projects or teams
2. **Assign API keys** to specific workspaces
3. **Monitor spend** per workspace
4. **Set limits** for each workspace

### Access Control:
- **Organization-level keys**: Access all workspaces
- **Workspace-specific keys**: Limited to a single workspace

## Next Steps

- [Get Started](../examples/get-started.md): First API call tutorial
- [Rate Limits](rate-limits.md): Understanding usage limits
- [Client SDKs](client-sdks.md): SDK installation and usage
- [API Keys Management](https://platform.claude.com/settings/keys): Console key management