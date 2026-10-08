# API Versioning

## Overview

When making API requests, you must send an `anthropic-version` request header. For example, `anthropic-version: 2023-06-01`. If you are using our [client SDKs](client-sdks.md), this is handled for you automatically.

## Versioning Strategy

For any given API version, we will preserve:

- **Existing input parameters**
- **Existing output parameters**

However, we may do the following:

- **Add additional optional inputs**
- **Add additional values to the output**
- **Change conditions for specific error types**
- **Add new variants to enum-like output values** (for example, streaming event types)

Generally, if you are using the API as documented in this reference, we will not break your usage.

## Version History

We always recommend using the latest API version whenever possible. Previous versions are considered deprecated and may be unavailable for new users.

### Current Versions:

#### `2023-06-01` (Recommended)
**Key Changes:**

1. **New format for streaming server-sent events (SSE):**
   - **Completions are incremental**: For example, `" Hello"`, `" my"`, `" name"`, `" is"`, `" Claude."` instead of `" Hello"`, `" Hello my"`, `" Hello my name"`, `" Hello my name is"`, `" Hello my name is Claude."`
   - **All events are named events**: Rather than data-only events
   - **Removed unnecessary `data: [DONE]` event**

2. **Removed legacy values in responses:**
   - Removed `exception` value
   - Removed `truncated` value

#### `2023-01-01` (Initial release, deprecated)
- Initial API release
- Basic functionality
- Considered deprecated

## Migration Guide

### From `2023-01-01` to `2023-06-01`

#### 1. Update Headers
Change your request headers to include:
```http
anthropic-version: 2023-06-01
```

#### 2. Streaming Changes
If you use streaming, update your event handling:

**Old format (2023-01-01):**
```javascript
// Data-only events with [DONE] marker
event.data: "Hello"
event.data: "Hello my"
event.data: "[DONE]"
```

**New format (2023-06-01):**
```javascript
// Named events without [DONE] marker
event.type: "message_start"
event.type: "content_block_start"
event.type: "content_block_delta"
event.type: "message_stop"
```

#### 3. Response Changes
Remove handling of deprecated fields:
- `exception`
- `truncated`

### Example Migration

#### Before (2023-01-01):
```python
import requests

headers = {
    "anthropic-version": "2023-01-01",
    "x-api-key": "your-api-key",
    "content-type": "application/json"
}

data = {
    "model": "claude-2",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "Hello"}]
}

response = requests.post(
    "https://api.anthropic.com/v1/messages",
    headers=headers,
    json=data
)

# Old error handling
if response.json().get("exception"):
    print("Exception occurred")
```

#### After (2023-06-01):
```python
import requests

headers = {
    "anthropic-version": "2023-06-01",  # Updated version
    "x-api-key": "your-api-key",
    "content-type": "application/json"
}

data = {
    "model": "claude-sonnet-4-5-20250929",  # Updated model
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "Hello"}]
}

response = requests.post(
    "https://api.anthropic.com/v1/messages",
    headers=headers,
    json=data
)

# New error handling
if response.status_code != 200:
    error_data = response.json()
    print(f"Error: {error_data.get('error', {}).get('message')}")
```

## Best Practices

### 1. Always Use Latest Version
- **Benefits**: Access to latest features and improvements
- **Security**: Latest security patches
- **Performance**: Optimized performance

### 2. Plan Migrations
- **Test in staging**: Test new versions before production
- **Monitor changes**: Review changelogs and documentation
- **Gradual rollout**: Update services incrementally

### 3. Version Pinning
- **Explicit versioning**: Specify exact API version
- **Avoid "latest"**: Don't use dynamic version selection
- **Document versions**: Record which version each service uses

### 4. Monitoring
- **Version usage**: Track which versions are in use
- **Deprecation warnings**: Monitor for deprecation notices
- **Migration readiness**: Plan for upcoming migrations

## Version Header Details

### Required Header:
```http
anthropic-version: 2023-06-01
```

### Header Rules:
1. **Must be included**: All requests require this header
2. **Format**: `YYYY-MM-DD` (ISO date format)
3. **Case-sensitive**: Header name is lowercase
4. **Single value**: Only one version can be specified

### Example Headers:
```http
# Correct
anthropic-version: 2023-06-01
x-api-key: sk-ant-api03-...
content-type: application/json

# Incorrect (missing version)
x-api-key: sk-ant-api03-...
content-type: application/json

# Incorrect (wrong format)
anthropic-version: latest
anthropic-version: 20230601
```

## Deprecation Policy

### Deprecation Timeline:
1. **Announcement**: Deprecation announced with notice period
2. **Support period**: Old version supported for limited time
3. **Migration period**: Time to migrate to new version
4. **End of life**: Old version no longer available

### Current Status:
- **`2023-06-01`**: Active and recommended
- **`2023-01-01`**: Deprecated, avoid new usage

## Error Handling

### Version Errors:

| Error Type | HTTP Status | Description |
|------------|-------------|-------------|
| `invalid_version` | 400 | Invalid version format |
| `unsupported_version` | 400 | Version not supported |
| `version_required` | 400 | Version header missing |

### Example Error Response:
```json
{
  "type": "error",
  "error": {
    "type": "unsupported_version",
    "message": "Version 2023-01-01 is no longer supported"
  }
}
```

## SDK Support

### Automatic Version Management:
Most SDKs handle versioning automatically:

**Python:**
```python
from anthropic import Anthropic

# SDK automatically uses latest version
client = Anthropic()
```

**JavaScript:**
```javascript
import Anthropic from '@anthropic-ai/sdk';

// SDK handles version header
const anthropic = new Anthropic();
```

### Manual Override:
If needed, you can specify a version:

**Python:**
```python
from anthropic import Anthropic

client = Anthropic(
    api_key="your-key",
    default_headers={"anthropic-version": "2023-06-01"}
)
```

## Backward Compatibility

### Guaranteed Compatibility:
- **Input parameters**: Existing parameters will work
- **Output structure**: Response format remains stable
- **Error codes**: Existing error types unchanged

### Potential Changes:
- **New parameters**: Additional optional parameters
- **Extended enums**: New values in enum fields
- **Enhanced features**: Improved functionality

## Testing Version Changes

### Recommended Testing:
1. **Unit tests**: Test individual API calls
2. **Integration tests**: Test complete workflows
3. **Performance tests**: Monitor response times
4. **Error tests**: Verify error handling

### Testing Checklist:
- [ ] All endpoints work correctly
- [ ] Error responses are handled
- [ ] Performance meets requirements
- [ ] New features function as expected
- [ ] Backward compatibility maintained

## Next Steps

### Immediate Actions:
1. **Update headers**: Change to `2023-06-01`
2. **Test thoroughly**: Verify functionality
3. **Monitor performance**: Check for issues

### Future Planning:
1. **Stay informed**: Watch for new versions
2. **Plan migrations**: Schedule updates
3. **Update documentation**: Keep docs current

## Additional Resources

### Documentation:
- [API Overview](overview.md)
- [Messages API](messages-api.md)
- [Client SDKs](client-sdks.md)

### Support:
- **API Documentation**: [https://platform.claude.com/docs](https://platform.claude.com/docs)
- **Community**: Anthropic developer community
- **Support**: Contact Anthropic support for issues

## Summary

- **Always include** `anthropic-version` header
- **Use latest version** (`2023-06-01`)
- **Plan migrations** for deprecated versions
- **Test thoroughly** before production deployment
- **Monitor usage** and stay informed about updates