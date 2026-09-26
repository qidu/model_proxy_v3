# Files API

## Overview

The Files API allows you to upload and manage files for use across multiple API calls. This is a beta feature that enables sharing files between different API requests.

**Endpoint:** `POST /v1/files`

## Upload File

### Request

**Method:** `POST /v1/files`

**Headers:**
- `Content-Type: multipart/form-data`
- `anthropic-version: 2023-06-01`
- `x-api-key: your-api-key`
- `anthropic-beta: files-api-2025-04-14` (required for beta access)

**Body:** `multipart/form-data` with file field

### Example Request

**cURL:**
```bash
curl https://api.anthropic.com/v1/files \
  -H 'Content-Type: multipart/form-data' \
  -H 'anthropic-version: 2023-06-01' \
  -H 'anthropic-beta: files-api-2025-04-14' \
  -H "X-Api-Key: $ANTHROPIC_API_KEY" \
  -F 'file=@/path/to/file'
```

**Python:**
```python
import requests

url = "https://api.anthropic.com/v1/files"
headers = {
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "files-api-2025-04-14",
    "x-api-key": "your-api-key"
}

with open("/path/to/file", "rb") as f:
    files = {"file": f}
    response = requests.post(url, headers=headers, files=files)
    print(response.json())
```

## Response Format

### FileMetadata Object

```json
{
  "id": "file_1234567890abcdef",
  "type": "file",
  "created_at": "2025-01-21T14:33:00Z",
  "filename": "document.pdf",
  "mime_type": "application/pdf",
  "size_bytes": 1048576,
  "downloadable": true
}
```

### Response Fields:

- `id: string` - Unique object identifier. The format and length of IDs may change over time.
- `created_at: string` - RFC 3339 datetime string representing when the file was created.
- `filename: string` - Original filename of the uploaded file.
- `mime_type: string` - MIME type of the file.
- `size_bytes: number` - Size of the file in bytes.
- `type: "file"` - Object type. For files, this is always `"file"`.
- `downloadable: optional boolean` - Whether the file can be downloaded.

## File Operations

### 1. Upload File
Upload a file to be used in subsequent API calls.

**Supported File Types:**
- Documents (PDF, plain text)
- Images (JPEG, PNG, GIF, WebP)
- Other supported formats

**Size Limits:**
- **Maximum size**: 500 MB per file
- **Total storage**: Varies by plan

### 2. Retrieve File
Get file metadata and potentially download the file.

**Endpoint:** `GET /v1/files/{file_id}`

**Example:**
```bash
curl https://api.anthropic.com/v1/files/file_1234567890abcdef \
  -H 'anthropic-version: 2023-06-01' \
  -H 'anthropic-beta: files-api-2025-04-14' \
  -H "X-Api-Key: $ANTHROPIC_API_KEY"
```

### 3. List Files
List all files uploaded by your organization.

**Endpoint:** `GET /v1/files`

**Example:**
```bash
curl https://api.anthropic.com/v1/files \
  -H 'anthropic-version: 2023-06-01' \
  -H 'anthropic-beta: files-api-2025-04-14' \
  -H "X-Api-Key: $ANTHROPIC_API_KEY"
```

### 4. Delete File
Remove a file from storage.

**Endpoint:** `DELETE /v1/files/{file_id}`

**Example:**
```bash
curl -X DELETE https://api.anthropic.com/v1/files/file_1234567890abcdef \
  -H 'anthropic-version: 2023-06-01' \
  -H 'anthropic-beta: files-api-2025-04-14' \
  -H "X-Api-Key: $ANTHROPIC_API_KEY"
```

## Using Files in API Calls

### Messages API with Files

Once a file is uploaded, you can reference it in Messages API calls using the file ID.

**Example:**
```json
{
  "model": "claude-sonnet-4-5-20250929",
  "max_tokens": 1024,
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Please summarize this document:"
        },
        {
          "type": "document",
          "source": {
            "type": "file",
            "file_id": "file_1234567890abcdef"
          }
        }
      ]
    }
  ]
}
```

### File Reference Types

#### 1. Direct File Reference
```json
{
  "type": "document",
  "source": {
    "type": "file",
    "file_id": "file_1234567890abcdef"
  }
}
```

#### 2. Base64 Encoded (Alternative)
```json
{
  "type": "document",
  "source": {
    "type": "base64",
    "media_type": "application/pdf",
    "data": "base64-encoded-data"
  }
}
```

## File Management

### Storage Limits

| Plan | Storage Limit | File Size Limit | Retention Period |
|------|---------------|-----------------|------------------|
| Free | 1 GB | 100 MB | 30 days |
| Pro | 10 GB | 500 MB | 90 days |
| Enterprise | Custom | Custom | Custom |

### File Lifecycle

1. **Upload**: File uploaded via API
2. **Storage**: File stored with metadata
3. **Usage**: Referenced in API calls
4. **Expiration**: Automatically deleted after retention period
5. **Manual Deletion**: Can be deleted via API

## Supported MIME Types

### Documents:
- `application/pdf` - PDF documents
- `text/plain` - Plain text files
- `text/markdown` - Markdown files
- `application/json` - JSON files

### Images:
- `image/jpeg` - JPEG images
- `image/png` - PNG images
- `image/gif` - GIF images
- `image/webp` - WebP images

### Other:
- `text/csv` - CSV files
- `application/xml` - XML files

## Error Handling

### Common Errors:

| Error Type | HTTP Status | Description |
|------------|-------------|-------------|
| `invalid_file` | 400 | Invalid file format or corrupted file |
| `file_too_large` | 413 | File exceeds size limit |
| `storage_limit_exceeded` | 403 | Storage limit reached |
| `file_not_found` | 404 | File ID does not exist |
| `permission_denied` | 403 | No permission to access file |

### Example Error Response:
```json
{
  "type": "error",
  "error": {
    "type": "file_too_large",
    "message": "File exceeds maximum size of 500 MB"
  }
}
```

## Security Considerations

### 1. Access Control
- Files are scoped to your organization
- API keys determine access permissions
- Consider using workspace-specific keys

### 2. Data Privacy
- Avoid uploading sensitive personal information
- Use appropriate file types for your use case
- Implement data retention policies

### 3. Security Best Practices
- Validate file types before upload
- Implement file size limits
- Monitor file upload patterns
- Regularly audit file usage

## Performance Considerations

### 1. Upload Performance
- Use appropriate chunk sizes for large files
- Implement retry logic for failed uploads
- Monitor upload speeds and optimize

### 2. Storage Optimization
- Compress files when possible
- Use appropriate file formats
- Clean up unused files regularly

### 3. Retrieval Performance
- Cache frequently accessed files
- Use file IDs for efficient lookups
- Monitor retrieval latency

## Integration Examples

### Complete Workflow Example:

```python
import requests
from anthropic import Anthropic

# Step 1: Upload file
def upload_file(file_path):
    url = "https://api.anthropic.com/v1/files"
    headers = {
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "files-api-2025-04-14",
        "x-api-key": "YOUR_API_KEY"
    }

    with open(file_path, "rb") as f:
        files = {"file": f}
        response = requests.post(url, headers=headers, files=files)
        return response.json()

# Step 2: Use file in Messages API
def analyze_document(file_id):
    client = Anthropic(api_key="YOUR_API_KEY")

    response = client.messages.create(
        model="claude-sonnet-4-5-20250929",
        max_tokens=1024,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "Analyze this document and provide key insights:"
                    },
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

    return response.content[0].text

# Usage
file_metadata = upload_file("document.pdf")
file_id = file_metadata["id"]
analysis = analyze_document(file_id)
print(analysis)
```

### Batch Processing Example:

```python
import concurrent.futures
import os

def process_files(directory):
    """Process multiple files concurrently."""
    client = Anthropic(api_key="YOUR_API_KEY")

    def process_file(file_path):
        # Upload file
        file_metadata = upload_file(file_path)
        file_id = file_metadata["id"]

        # Analyze with Claude
        response = client.messages.create(
            model="claude-sonnet-4-5-20250929",
            max_tokens=512,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": "Summarize this document:"
                        },
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

        return {
            "filename": os.path.basename(file_path),
            "summary": response.content[0].text,
            "file_id": file_id
        }

    # Process files concurrently
    files = [os.path.join(directory, f) for f in os.listdir(directory)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        results = list(executor.map(process_file, files))

    return results
```

## Best Practices

### 1. File Preparation
- **Validate file types** before upload
- **Compress large files** when possible
- **Use appropriate formats** for your use case
- **Check file size** against limits

### 2. Upload Strategy
- **Implement retry logic** for failed uploads
- **Use appropriate chunk sizes** for large files
- **Monitor upload progress**
- **Handle network interruptions**

### 3. File Management
- **Regularly clean up** unused files
- **Monitor storage usage**
- **Implement retention policies**
- **Track file access patterns**

### 4. Security
- **Validate file contents** for security risks
- **Implement access controls**
- **Monitor for suspicious activity**
- **Regularly audit file permissions**

## Limitations

### Current Beta Limitations:
- **Availability**: Beta feature, subject to change
- **Storage limits**: Varies by plan and usage
- **File types**: Limited to supported formats
- **Performance**: May have rate limits during beta

### Planned Improvements:
- **Increased storage limits**
- **Additional file type support**
- **Enhanced security features**
- **Improved performance**

## Next Steps

- [Messages API](messages-api.md): Using files in conversations
- [Token Counting API](token-counting-api.md): Estimating token usage with files
- [Rate Limits](rate-limits.md): Understanding usage tiers
- [Examples](../examples/): Code samples and tutorials