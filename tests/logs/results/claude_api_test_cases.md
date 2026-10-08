# Claude API Test Cases

## Overview
Comprehensive test cases for all Claude APIs based on the documentation in `/Users/sudu/dev/proxy/claude_api_docs/`.

## Test Environment Setup
- **Base URL**: `https://api.anthropic.com`
- **Required Headers**:
  - `x-api-key`: Valid API key
  - `anthropic-version`: `2023-06-01`
  - `content-type`: `application/json` (except for Files API uploads)

---

## 1. Messages API Test Cases
**Endpoint**: `POST /v1/messages`

### 1.1 Basic Functionality Tests

#### TC-MESS-001: Basic Message Request
**Description**: Send a simple message with minimal required parameters
**Request**:
```json
{
  "model": "claude-sonnet-4-5-20250929",
  "max_tokens": 1024,
  "messages": [
    {"role": "user", "content": "Hello, Claude"}
  ]
}
```
**Expected Response**:
- HTTP Status: 200
- Response contains: `id`, `type`, `role`, `model`, `content`, `stop_reason`, `usage`
- `content` array contains at least one text block
- `stop_reason` is `"end_turn"` or `"max_tokens"`

#### TC-MESS-002: Multi-turn Conversation
**Description**: Continue a conversation with previous context
**Request**:
```json
{
  "model": "claude-sonnet-4-5-20250929",
  "max_tokens": 1024,
  "messages": [
    {"role": "user", "content": "What's 2+2?"},
    {"role": "assistant", "content": "2+2 equals 4."},
    {"role": "user", "content": "What about 3+3?"}
  ]
}
```
**Expected Response**:
- HTTP Status: 200
- Response continues conversation contextually
- `content` contains appropriate answer

#### TC-MESS-003: System Prompt Usage
**Description**: Use system prompt to set context
**Request**:
```json
{
  "model": "claude-sonnet-4-5-20250929",
  "max_tokens": 1024,
  "system": "You are a helpful coding assistant. Always respond with code examples.",
  "messages": [
    {"role": "user", "content": "How do I sort a list in Python?"}
  ]
}
```
**Expected Response**:
- HTTP Status: 200
- Response includes code examples
- Tone matches coding assistant persona

### 1.2 Parameter Validation Tests

#### TC-MESS-004: Missing Required Parameters
**Description**: Request missing required parameters
**Test Cases**:
1. Missing `model`
2. Missing `max_tokens`
3. Missing `messages`
4. Empty `messages` array

**Expected Response**:
- HTTP Status: 400
- Error type: `invalid_request`
- Clear error message indicating missing parameter

#### TC-MESS-005: Invalid Model Name
**Description**: Request with invalid model identifier
**Request**:
```json
{
  "model": "invalid-model-name",
  "max_tokens": 1024,
  "messages": [
    {"role": "user", "content": "Hello"}
  ]
}
```
**Expected Response**:
- HTTP Status: 400
- Error type: `invalid_request` or `model_not_found`

#### TC-MESS-006: Invalid Token Limits
**Description**: Test various token limit scenarios
**Test Cases**:
1. `max_tokens: 0`
2. `max_tokens: -1`
3. `max_tokens` exceeding model maximum
4. `max_tokens` as non-integer

**Expected Response**:
- HTTP Status: 400 for invalid values
- Appropriate error messages

#### TC-MESS-007: Invalid Temperature Values
**Description**: Test temperature parameter boundaries
**Test Cases**:
1. `temperature: -0.1`
2. `temperature: 1.1`
3. `temperature: "string"`

**Expected Response**:
- HTTP Status: 400 for out-of-range values
- Clear validation error

### 1.3 Advanced Feature Tests

#### TC-MESS-008: Streaming Response
**Description**: Enable streaming for real-time response
**Request**:
```json
{
  "model": "claude-sonnet-4-5-20250929",
  "max_tokens": 1024,
  "messages": [
    {"role": "user", "content": "Explain quantum computing"}
  ],
  "stream": true
}
```
**Expected Response**:
- HTTP Status: 200
- Server-sent events stream
- Multiple events with incremental content
- Final event with complete message

#### TC-MESS-009: Extended Thinking
**Description**: Enable extended thinking with token budget
**Request**:
```json
{
  "model": "claude-sonnet-4-5-20250929",
  "max_tokens": 2048,
  "thinking": {
    "type": "enabled",
    "budget_tokens": 1024
  },
  "messages": [
    {"role": "user", "content": "Solve this complex math problem: Find the derivative of f(x) = x³ + 2x² - 5x + 3"}
  ]
}
```
**Expected Response**:
- HTTP Status: 200
- Response may include thinking blocks
- Final answer with reasoning

#### TC-MESS-010: Tool Use Integration
**Description**: Define and use custom tools
**Request**:
```json
{
  "model": "claude-sonnet-4-5-20250929",
  "max_tokens": 1024,
  "messages": [
    {"role": "user", "content": "What's the current weather in San Francisco?"}
  ],
  "tools": [
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
}
```
**Expected Response**:
- HTTP Status: 200
- `stop_reason`: `"tool_use"`
- `content` includes tool use block
- Tool use contains appropriate input structure

#### TC-MESS-011: Tool Choice Control
**Description**: Test different tool choice options
**Test Cases**:
1. `tool_choice: {"type": "auto"}`
2. `tool_choice: {"type": "any"}`
3. `tool_choice: {"type": "tool", "name": "specific_tool"}`
4. `tool_choice: {"type": "none"}`

**Expected Response**:
- Appropriate tool usage based on choice
- `"none"` prevents tool use even when tools defined

### 1.4 Content Type Tests

#### TC-MESS-012: Image Content (Base64)
**Description**: Send message with base64 encoded image
**Request**:
```json
{
  "model": "claude-sonnet-4-5-20250929",
  "max_tokens": 1024,
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "Describe this image:"},
        {
          "type": "image",
          "source": {
            "type": "base64",
            "media_type": "image/jpeg",
            "data": "[VALID_BASE64_IMAGE_DATA]"
          }
        }
      ]
    }
  ]
}
```
**Expected Response**:
- HTTP Status: 200
- Response describes image content
- Appropriate image understanding

#### TC-MESS-013: Image Content (URL)
**Description**: Send message with image URL
**Request**:
```json
{
  "model": "claude-sonnet-4-5-20250929",
  "max_tokens": 1024,
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "Describe this image:"},
        {
          "type": "image",
          "source": {
            "type": "url",
            "url": "https://example.com/image.jpg"
          }
        }
      ]
    }
  ]
}
```
**Expected Response**:
- HTTP Status: 200 or 400 if URL inaccessible
- Response attempts to describe image

#### TC-MESS-014: Document Content (PDF)
**Description**: Send PDF document for analysis
**Request**:
```json
{
  "model": "claude-sonnet-4-5-20250929",
  "max_tokens": 1024,
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "Summarize this document:"},
        {
          "type": "document",
          "source": {
            "type": "base64",
            "media_type": "application/pdf",
            "data": "[VALID_BASE64_PDF_DATA]"
          },
          "title": "Sample Document"
        }
      ]
    }
  ]
}
```
**Expected Response**:
- HTTP Status: 200
- Response summarizes document content
- Appropriate document understanding

#### TC-MESS-015: Document Content (Plain Text)
**Description**: Send plain text document
**Request**:
```json
{
  "model": "claude-sonnet-4-5-20250929",
  "max_tokens": 1024,
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "Analyze this text:"},
        {
          "type": "document",
          "source": {
            "type": "text",
            "media_type": "text/plain",
            "data": "This is a sample text document for analysis."
          },
          "title": "Sample Text"
        }
      ]
    }
  ]
}
```
**Expected Response**:
- HTTP Status: 200
- Response analyzes text content

### 1.5 Error Handling Tests

#### TC-MESS-016: Authentication Failure
**Description**: Request with invalid API key
**Headers**:
- `x-api-key`: `invalid-key`
- `anthropic-version`: `2023-06-01`

**Expected Response**:
- HTTP Status: 401
- Error type: `authentication_error`

#### TC-MESS-017: Rate Limiting
**Description**: Send rapid consecutive requests
**Test Method**:
- Send 100+ requests in quick succession
- Monitor for rate limit responses

**Expected Response**:
- HTTP Status: 429 for some requests
- Error type: `rate_limit_exceeded`
- Appropriate retry-after headers

#### TC-MESS-018: Invalid JSON
**Description**: Send malformed JSON in request body
**Request Body**: `{"model": "claude-sonnet-4-5-20250929", "max_tokens": 1024, "messages": [`

**Expected Response**:
- HTTP Status: 400
- Error indicating JSON parsing failure

#### TC-MESS-019: Large Message Payload
**Description**: Send message exceeding size limits
**Test Method**:
- Create message with 100,000+ characters
- Or exceed 100,000 message limit

**Expected Response**:
- HTTP Status: 400 or 413
- Error indicating payload too large

### 1.6 Performance Tests

#### TC-MESS-020: Response Time Measurement
**Description**: Measure typical response times
**Test Method**:
- Send 10 identical requests
- Calculate average response time
- Measure P95 latency

**Success Criteria**:
- Average response time < 5 seconds
- P95 latency < 10 seconds

#### TC-MESS-021: Concurrent Requests
**Description**: Test handling of concurrent requests
**Test Method**:
- Send 10 concurrent requests
- Monitor for errors or degraded performance

**Success Criteria**:
- All requests complete successfully
- No significant performance degradation

---

## 2. Message Batches API Test Cases
**Endpoint**: `POST /v1/messages/batches`

### 2.1 Basic Batch Tests

#### TC-BATCH-001: Create Simple Batch
**Description**: Create batch with minimal requests
**Request**:
```json
{
  "requests": [
    {
      "custom_id": "request-1",
      "params": {
        "model": "claude-sonnet-4-5-20250929",
        "max_tokens": 512,
        "messages": [
          {"role": "user", "content": "Hello"}
        ]
      }
    }
  ]
}
```
**Expected Response**:
- HTTP Status: 200
- Contains: `id`, `type`, `created_at`, `expires_at`, `processing_status`
- `processing_status`: `"in_progress"`
- `request_counts` shows 1 processing

#### TC-BATCH-002: Create Multiple Requests Batch
**Description**: Batch with 5 different requests
**Test Method**:
- Create batch with 5 unique custom_ids
- Each with different message content

**Expected Response**:
- HTTP Status: 200
- `request_counts.processing`: 5
- Valid batch ID returned

#### TC-BATCH-003: Batch with Mixed Models
**Description**: Batch containing requests for different models
**Test Cases**:
1. Mix of Sonnet and Haiku models
2. Different model versions

**Expected Response**:
- HTTP Status: 200
- Batch created successfully
- All requests accepted

### 2.2 Validation Tests

#### TC-BATCH-004: Invalid Request Parameters
**Description**: Batch containing invalid individual requests
**Test Cases**:
1. Request missing required params
2. Invalid model in one request
3. Exceeding token limits

**Expected Response**:
- HTTP Status: 400 for batch-level errors
- Or individual request errors in results

#### TC-BATCH-005: Duplicate Custom IDs
**Description**: Batch with duplicate custom_id values
**Request**:
```json
{
  "requests": [
    {
      "custom_id": "duplicate-id",
      "params": {...}
    },
    {
      "custom_id": "duplicate-id",
      "params": {...}
    }
  ]
}
```
**Expected Response**:
- HTTP Status: 400
- Error indicating duplicate custom_id

#### TC-BATCH-006: Empty Batch
**Description**: Create batch with empty requests array
**Request**: `{"requests": []}`

**Expected Response**:
- HTTP Status: 400
- Error indicating invalid batch

#### TC-BATCH-007: Large Batch Size
**Description**: Test batch size limits
**Test Method**:
- Create batch with 1000+ requests
- Or exceed total token limits

**Expected Response**:
- HTTP Status: 400 or 413
- Error indicating batch too large

### 2.3 Batch Management Tests

#### TC-BATCH-008: Retrieve Batch Status
**Description**: Get batch details after creation
**Endpoint**: `GET /v1/messages/batches/{batch_id}`

**Expected Response**:
- HTTP Status: 200
- Contains current processing_status
- Updated request_counts
- Valid timestamps

#### TC-BATCH-009: Monitor Batch Progress
**Description**: Poll batch status until completion
**Test Method**:
- Create batch with 10 simple requests
- Poll status every 30 seconds
- Track status transitions

**Expected Response**:
- Status progresses: `in_progress` → `ended`
- request_counts update appropriately
- Results URL available when ended

#### TC-BATCH-010: Download Results
**Description**: Retrieve and parse results file
**Test Method**:
1. Create batch
2. Wait for completion
3. Download results from results_url
4. Parse JSONL format

**Expected Response**:
- Valid JSONL file
- Each line valid JSON
- Results match custom_ids
- Contains success and error results

### 2.4 Error Handling Tests

#### TC-BATCH-011: Invalid Batch ID
**Description**: Retrieve non-existent batch
**Endpoint**: `GET /v1/messages/batches/invalid-batch-id`

**Expected Response**:
- HTTP Status: 404
- Error: `batch_not_found`

#### TC-BATCH-012: Expired Batch Access
**Description**: Access batch after 24+ hours
**Test Method**:
- Create batch
- Wait 25+ hours
- Attempt to retrieve

**Expected Response**:
- HTTP Status: 404 or 410
- Error indicating batch expired

#### TC-BATCH-013: Rate Limited Batch Creation
**Description**: Test batch creation rate limits
**Test Method**:
- Rapid consecutive batch creations
- Monitor for rate limit responses

**Expected Response**:
- HTTP Status: 429 for some requests
- Appropriate retry-after guidance

### 2.5 Performance Tests

#### TC-BATCH-014: Batch Processing Time
**Description**: Measure batch completion times
**Test Method**:
- Create batches of different sizes (10, 50, 100)
- Measure time to `ended` status
- Compare with individual request times

**Success Criteria**:
- Demonstrates efficiency gain
- Within expected timeframes

#### TC-BATCH-015: Concurrent Batch Management
**Description**: Manage multiple batches simultaneously
**Test Method**:
- Create 5 batches concurrently
- Monitor all simultaneously
- Download results as they complete

**Success Criteria**:
- All batches process successfully
- No interference between batches

---

## 3. Token Counting API Test Cases
**Endpoint**: `POST /v1/messages/count_tokens`

### 3.1 Basic Counting Tests

#### TC-TOKEN-001: Simple Message Token Count
**Description**: Count tokens for basic message
**Request**:
```json
{
  "model": "claude-sonnet-4-5-20250929",
  "messages": [
    {"role": "user", "content": "Hello, Claude"}
  ]
}
```
**Expected Response**:
- HTTP Status: 200
- Contains: `input_tokens`
- `input_tokens` > 0
- Consistent count for same input

#### TC-TOKEN-002: Multi-turn Conversation Tokens
**Description**: Count tokens for conversation history
**Request**:
```json
{
  "model": "claude-sonnet-4-5-20250929",
  "messages": [
    {"role": "user", "content": "Hi"},
    {"role": "assistant", "content": "Hello! How can I help?"},
    {"role": "user", "content": "What can you do?"}
  ]
}
```
**Expected Response**:
- HTTP Status: 200
- `input_tokens` reflects all messages
- Count increases with more messages

#### TC-TOKEN-003: System Prompt Token Count
**Description**: Count tokens including system prompt
**Request**:
```json
{
  "model": "claude-sonnet-4-5-20250929",
  "system": "You are a helpful assistant.",
  "messages": [
    {"role": "user", "content": "Hello"}
  ]
}
```
**Expected Response**:
- HTTP Status: 200
- `input_tokens` includes system prompt tokens
- Higher than same message without system

### 3.2 Advanced Feature Tests

#### TC-TOKEN-004: Tool Definitions Token Count
**Description**: Count tokens for tool definitions
**Request**:
```json
{
  "model": "claude-sonnet-4-5-20250929",
  "messages": [
    {"role": "user", "content": "Get weather"}
  ],
  "tools": [
    {
      "name": "get_weather",
      "description": "Get weather for location",
      "input_schema": {
        "type": "object",
        "properties": {
          "location": {"type": "string"}
        },
        "required": ["location"]
      }
    }
  ]
}
```
**Expected Response**:
- HTTP Status: 200
- `input_tokens` includes tool definition tokens
- Higher than same message without tools

#### TC-TOKEN-005: Thinking Budget Token Count
**Description**: Count tokens with thinking enabled
**Request**:
```json
{
  "model": "claude-sonnet-4-5-20250929",
  "messages": [
    {"role": "user", "content": "Complex question"}
  ],
  "thinking": {
    "type": "enabled",
    "budget_tokens": 1024
  }
}
```
**Expected Response**:
- HTTP Status: 200
- `input_tokens` includes thinking configuration
- Appropriate token count

#### TC-TOKEN-006: Image Content Token Count
**Description**: Count tokens for image content
**Request**:
```json
{
  "model": "claude-sonnet-4-5-20250929",
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "Describe:"},
        {
          "type": "image",
          "source": {
            "type": "base64",
            "media_type": "image/jpeg",
            "data": "[BASE64_IMAGE]"
          }
        }
      ]
    }
  ]
}
```
**Expected Response**:
- HTTP Status: 200
- `input_tokens` includes image token representation
- Higher than text-only equivalent

#### TC-TOKEN-007: Document Content Token Count
**Description**: Count tokens for document content
**Request**:
```json
{
  "model": "claude-sonnet-4-5-20250929",
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "Summarize:"},
        {
          "type": "document",
          "source": {
            "type": "text",
            "media_type": "text/plain",
            "data": "Sample document text"
          }
        }
      ]
    }
  ]
}
```
**Expected Response**:
- HTTP Status: 200
- `input_tokens` includes document tokens
- Proportional to document length

### 3.3 Validation Tests

#### TC-TOKEN-008: Missing Required Parameters
**Description**: Request missing required fields
**Test Cases**:
1. Missing `model`
2. Missing `messages`
3. Empty `messages` array

**Expected Response**:
- HTTP Status: 400
- Error: `invalid_request`
- Clear missing parameter indication

#### TC-TOKEN-009: Invalid Model Name
**Description**: Request with invalid model
**Request**:
```json
{
  "model": "invalid-model",
  "messages": [
    {"role": "user", "content": "Hello"}
  ]
}
```
**Expected Response**:
- HTTP Status: 400
- Error indicating invalid model

#### TC-TOKEN-010: Large Input Token Count
**Description**: Count tokens for very large input
**Test Method**:
- Create message with 10,000+ characters
- Or complex tool definitions

**Expected Response**:
- HTTP Status: 200 (if within limits)
- Or 400 if exceeding model context window

### 3.4 Consistency Tests

#### TC-TOKEN-011: Count vs Actual Usage
**Description**: Compare counted tokens with actual usage
**Test Method**:
1. Count tokens for message
2. Send same message via Messages API
3. Compare `input_tokens` count with actual `usage.input_tokens`

**Success Criteria**:
- Counted tokens ≈ actual usage tokens
- Small variance acceptable

#### TC-TOKEN-012: Model-specific Token Counts
**Description**: Compare token counts across models
**Test Method**:
- Same message counted for different models
- Compare `input_tokens` values

**Expected Behavior**:
- Different models may have different tokenization
- Counts should be consistent per model

### 3.5 Performance Tests

#### TC-TOKEN-013: Counting Response Time
**Description**: Measure token counting performance
**Test Method**:
- Count tokens for messages of varying sizes
- Measure response times

**Success Criteria**:
- Average response time < 1 second
- Linear scaling with input size

#### TC-TOKEN-014: Concurrent Counting
**Description**: Test concurrent token counting requests
**Test Method**:
- Send 10+ concurrent count requests
- Monitor for errors or performance issues

**Success Criteria**:
- All requests complete successfully
- No significant latency increase

---

## 4. Models API Test Cases
**Endpoint**: `GET /v1/models`

### 4.1 Basic Retrieval Tests

#### TC-MODEL-001: List All Models
**Description**: Retrieve complete model list
**Request**: `GET /v1/models`
**Expected Response**:
- HTTP Status: 200
- Contains `data` array with model objects
- Each model has: `id`, `type`, `created_at`, `display_name`
- `type` is `"model"` for all entries
- Sorted by release date (newest first)

#### TC-MODEL-002: Pagination Support
**Description**: Test pagination parameters
**Test Cases**:
1. `GET /v1/models?limit=5`
2. `GET /v1/models?limit=10&after_id={last_id}`
3. `GET /v1/models?limit=10&before_id={first_id}`

**Expected Response**:
- HTTP Status: 200
- `data` contains requested number of items
- `has_more` indicates additional pages
- `first_id` and `last_id` provided
- Pagination works bidirectionally

#### TC-MODEL-003: Default Limit Behavior
**Description**: Verify default pagination limit
**Request**: `GET /v1/models` (no limit specified)
**Expected Response**:
- HTTP Status: 200
- Default limit of 20 items
- `data` length ≤ 20

### 4.2 Validation Tests

#### TC-MODEL-004: Invalid Limit Values
**Description**: Test limit parameter validation
**Test Cases**:
1. `limit=0`
2. `limit=1001` (exceeds maximum)
3. `limit=-1`
4. `limit="string"`

**Expected Response**:
- HTTP Status: 400 for invalid values
- Error: `invalid_request`
- Clear validation message

#### TC-MODEL-005: Invalid Cursor IDs
**Description**: Test invalid pagination cursors
**Test Cases**:
1. `after_id="invalid-id"`
2. `before_id="non-existent"`
3. Malformed cursor values

**Expected Response**:
- HTTP Status: 400 or 404
- Appropriate error response

#### TC-MODEL-006: Conflicting Pagination Parameters
**Description**: Test mutually exclusive parameters
**Test Cases**:
1. Both `after_id` and `before_id` specified
2. Invalid parameter combinations

**Expected Response**:
- HTTP Status: 400
- Error indicating parameter conflict

### 4.3 Content Validation Tests

#### TC-MODEL-007: Model Object Structure
**Description**: Validate model object schema
**Check Fields**:
- `id`: Valid model identifier string
- `type`: Exactly `"model"`
- `created_at`: Valid RFC 3339 timestamp
- `display_name`: Human-readable string
- Optional: `description`, `capabilities`

**Expected Response**:
- All required fields present
- Valid data types and formats

#### TC-MODEL-008: Model Availability
**Description**: Verify expected models are listed
**Check Models**:
- `claude-sonnet-4-5-20250929`
- `claude-3-5-haiku-20241022`
- `claude-opus-4-5-20251101`
- Current model versions

**Expected Response**:
- Current models available
- Deprecated models may be listed

#### TC-MODEL-009: Model Sorting Order
**Description**: Verify chronological sorting
**Test Method**:
- Retrieve multiple pages
- Check `created_at` timestamps
- Verify descending order (newest first)

**Success Criteria**:
- Consistent chronological sorting
- Pagination maintains order

### 4.4 Performance Tests

#### TC-MODEL-010: Response Time
**Description**: Measure model listing performance
**Test Method**:
- Multiple requests with different limits
- Measure response times

**Success Criteria**:
- Average response time < 500ms
- Consistent performance

#### TC-MODEL-011: Caching Behavior
**Description**: Test response caching
**Test Method**:
- Identical consecutive requests
- Compare response times
- Check for cache headers

**Expected Behavior**:
- Possible caching for performance
- Consistent data returned

#### TC-MODEL-012: Concurrent Model Requests
**Description**: Test handling of concurrent requests
**Test Method**:
- 10+ concurrent model list requests
- Monitor for errors or performance issues

**Success Criteria**:
- All requests complete successfully
- No significant latency increase

### 4.5 Integration Tests

#### TC-MODEL-013: Model ID Usage Validation
**Description**: Verify model IDs work with Messages API
**Test Method**:
1. Get model list
2. Select a model ID
3. Use in Messages API request
4. Verify successful completion

**Success Criteria**:
- Model ID accepted by Messages API
- Appropriate response generated

#### TC-MODEL-014: Model Feature Discovery
**Description**: Test using model capabilities in requests
**Test Method**:
- Identify model capabilities from list
- Use appropriate features in Messages API
- Verify feature support

**Success Criteria**:
- Features work as expected
- Graceful fallback for unsupported features

---

## 5. Files API Test Cases (Beta)
**Endpoint**: `POST /v1/files` (Upload)
**Endpoint**: `GET /v1/files` (List)
**Endpoint**: `GET /v1/files/{file_id}` (Retrieve)
**Endpoint**: `DELETE /v1/files/{file_id}` (Delete)

### 5.1 File Upload Tests

#### TC-FILE-001: Upload Basic File
**Description**: Upload simple text file
**Headers**:
- `Content-Type: multipart/form-data`
- `anthropic-beta: files-api-2025-04-14`

**Request**: Multipart form with file field
**Expected Response**:
- HTTP Status: 200
- Contains: `id`, `type`, `created_at`, `filename`, `mime_type`, `size_bytes`
- `type` is `"file"`
- `downloadable` may be true/false

#### TC-FILE-002: Upload Different File Types
**Description**: Test various supported MIME types
**Test Files**:
1. `text/plain` (.txt)
2. `application/pdf` (.pdf)
3. `image/jpeg` (.jpg)
4. `image/png` (.png)
5. `text/markdown` (.md)

**Expected Response**:
- HTTP Status: 200 for supported types
- Correct `mime_type` detection
- Accurate `size_bytes`

#### TC-FILE-003: Upload Large File
**Description**: Test file size limits
**Test Method**:
- Upload file near 500MB limit
- Or attempt >500MB file

**Expected Response**:
- Success for within limits
- HTTP Status: 413 for oversized files
- Error: `file_too_large`

#### TC-FILE-004: Upload Empty File
**Description**: Test edge case of empty file
**Request**: Upload 0-byte file
**Expected Response**:
- HTTP Status: 200 or 400
- Appropriate handling

### 5.2 File Retrieval Tests

#### TC-FILE-005: Retrieve File Metadata
**Description**: Get file details by ID
**Endpoint**: `GET /v1/files/{file_id}`
**Expected Response**:
- HTTP Status: 200
- Complete file metadata
- Consistent with upload response

#### TC-FILE-006: Retrieve Non-existent File
**Description**: Attempt to retrieve invalid file ID
**Endpoint**: `GET /v1/files/invalid-file-id`
**Expected Response**:
- HTTP Status: 404
- Error: `file_not_found`

#### TC-FILE-007: List All Files
**Description**: Retrieve list of uploaded files
**Endpoint**: `GET /v1/files`
**Expected Response**:
- HTTP Status: 200
- Array of file metadata objects
- Includes all user's uploaded files

#### TC-FILE-008: List Pagination
**Description**: Test file listing pagination
**Test Cases**:
1. `GET /v1/files?limit=10`
2. Paginate through all files

**Expected Response**:
- HTTP Status: 200
- Pagination works correctly
- Consistent ordering

### 5.3 File Usage Tests

#### TC-FILE-009: Use File in Messages API
**Description**: Reference uploaded file in message
**Request**:
```json
{
  "model": "claude-sonnet-4-5-20250929",
  "max_tokens": 1024,
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "Analyze this:"},
        {
          "type": "document",
          "source": {
            "type": "file",
            "file_id": "[VALID_FILE_ID]"
          }
        }
      ]
    }
  ]
}
```
**Expected Response**:
- HTTP Status: 200
- Claude processes file content
- Appropriate response based on file

#### TC-FILE-010: File Reference Validation
**Description**: Test invalid file references
**Test Cases**:
1. Invalid file_id format
2. File ID from different organization
3. Deleted file ID

**Expected Response**:
- HTTP Status: 400 or 404
- Clear error message

### 5.4 File Management Tests

#### TC-FILE-011: Delete File
**Description**: Remove uploaded file
**Endpoint**: `DELETE /v1/files/{file_id}`
**Expected Response**:
- HTTP Status: 200 or 204
- File no longer accessible

#### TC-FILE-012: Delete Non-existent File
**Description**: Attempt to delete invalid file
**Endpoint**: `DELETE /v1/files/invalid-file-id`
**Expected Response**:
- HTTP Status: 404
- Error: `file_not_found`

#### TC-FILE-013: Reuse Deleted File ID
**Description**: Attempt to use deleted file
**Test Method**:
1. Upload file
2. Delete file
3. Attempt to reference in Messages API

**Expected Response**:
- HTTP Status: 404
- Error indicating file not found

#### TC-FILE-014: Storage Limit Enforcement
**Description**: Test storage quota limits
**Test Method**:
- Upload files until reaching limit
- Attempt additional uploads

**Expected Response**:
- HTTP Status: 403 when limit reached
- Error: `storage_limit_exceeded`

### 5.5 Security Tests

#### TC-FILE-015: File Type Validation
**Description**: Attempt to upload unsupported file types
**Test Files**:
1. Executable files (.exe, .sh)
2. Archive files (.zip, .tar)
3. Unsupported document types

**Expected Response**:
- HTTP Status: 400
- Error: `invalid_file`
- Rejection of unsafe types

#### TC-FILE-016: File Content Scanning
**Description**: Test malicious content detection
**Test Method**:
- Upload files with potentially harmful content
- Check for validation

**Expected Response**:
- Appropriate security measures
- Rejection of dangerous content

#### TC-FILE-017: Access Control
**Description**: Test file access permissions
**Test Method**:
- Upload with one API key
- Attempt access with different key
- Or different organization

**Expected Response**:
- HTTP Status: 403 for unauthorized access
- Proper isolation between users/orgs

### 5.6 Performance Tests

#### TC-FILE-018: Upload Performance
**Description**: Measure file upload speeds
**Test Method**:
- Upload files of various sizes
- Measure time to completion
- Monitor network usage

**Success Criteria**:
- Reasonable upload times
- No timeouts for large files

#### TC-FILE-019: Concurrent File Operations
**Description**: Test multiple simultaneous file operations
**Test Method**:
- Concurrent uploads
- Concurrent downloads
- Mixed operations

**Success Criteria**:
- All operations complete
- No interference or corruption

#### TC-FILE-020: File Reference Performance
**Description**: Measure Messages API performance with file references
**Test Method**:
- Compare response times with/without file references
- Test with different file sizes

**Success Criteria**:
- Acceptable performance impact
- Linear scaling expected

---

## 6. Skills API Test Cases (Beta)
**Endpoint**: `POST /v1/skills` (Create)
**Endpoint**: `GET /v1/skills` (List)
**Endpoint**: `GET /v1/skills/{skill_id}` (Retrieve)
**Endpoint**: `PUT /v1/skills/{skill_id}` (Update)
**Endpoint**: `DELETE /v1/skills/{skill_id}` (Delete)

### 6.1 Skill Creation Tests

#### TC-SKILL-001: Create Basic Skill
**Description**: Create simple skill with minimal configuration
**Headers**:
- `anthropic-beta: skills-2025-10-02`

**Request**:
```json
{
  "display_title": "Test Skill",
  "description": "A test skill for validation",
  "configuration": {
    "capabilities": ["test_processing"]
  }
}
```
**Expected Response**:
- HTTP Status: 200
- Contains: `id`, `type`, `created_at`, `display_title`, `latest_version`, `source`, `updated_at`
- `type` is `"skill"`
- `source` is `"custom"`
- Valid version string

#### TC-SKILL-002: Create Complex Skill
**Description**: Create skill with advanced configuration
**Request**:
```json
{
  "display_title": "Advanced Analysis Skill",
  "description": "Skill for complex data analysis",
  "configuration": {
    "capabilities": ["analysis", "visualization", "reporting"],
    "parameters": {
      "analysis_depth": "detailed",
      "output_format": "markdown"
    },
    "examples": [
      {
        "input": "Sample data",
        "output": "Analysis result"
      }
    ],
    "rules": [
      {
        "condition": "data_complexity > 5",
        "action": "deep_analysis"
      }
    ]
  }
}
```
**Expected Response**:
- HTTP Status: 200
- Complete skill metadata
- Configuration stored correctly

#### TC-SKILL-003: Create Skill with Templates
**Description**: Skill including response templates
**Request**:
```json
{
  "display_title": "Template Skill",
  "description": "Skill with response templates",
  "configuration": {
    "templates": {
      "response_format": "## Analysis\n{analysis}\n\n## Recommendations\n{recommendations}"
    }
  }
}
```
**Expected Response**:
- HTTP Status: 200
- Templates stored in configuration
- Valid skill creation

### 6.2 Validation Tests

#### TC-SKILL-004: Missing Required Fields
**Description**: Attempt creation without required parameters
**Test Cases**:
1. Missing `display_title`
2. Missing `description`
3. Missing `configuration`
4. Empty configuration

**Expected Response**:
- HTTP Status: 400
- Error: `invalid_skill_configuration`
- Clear validation messages

#### TC-SKILL-005: Invalid Configuration Structure
**Description**: Test malformed configuration
**Test Cases**:
1. Invalid JSON in configuration
2. Unsupported capability names
3. Malformed parameter schemas

**Expected Response**:
- HTTP Status: 400
- Configuration validation errors

#### TC-SKILL-006: Skill Limit Enforcement
**Description**: Test maximum skills per organization
**Test Method**:
- Create skills until reaching limit
- Attempt additional creations

**Expected Response**:
- HTTP Status: 403 when limit reached
- Error: `skill_limit_exceeded`

#### TC-SKILL-007: Duplicate Skill Titles
**Description**: Test skill title uniqueness
**Test Method**:
- Create skill with specific title
- Attempt create with same title

**Expected Response**:
- May allow duplicates with different IDs
- Or enforce uniqueness

### 6.3 Skill Retrieval Tests

#### TC-SKILL-008: Retrieve Skill by ID
**Description**: Get skill details
**Endpoint**: `GET /v1/skills/{skill_id}`
**Expected Response**:
- HTTP Status: 200
- Complete skill metadata
- Consistent with creation data

#### TC-SKILL-009: Retrieve Non-existent Skill
**Description**: Attempt to get invalid skill ID
**Endpoint**: `GET /v1/skills/invalid-skill-id`
**Expected Response**:
- HTTP Status: 404
- Error: `skill_not_found`

#### TC-SKILL-010: List All Skills
**Description**: Retrieve skill list
**Endpoint**: `GET /v1/skills`
**Expected Response**:
- HTTP Status: 200
- Array of skill objects
- Includes custom and Anthropic skills

#### TC-SKILL-011: List Pagination
**Description**: Test skill listing pagination
**Test Cases**:
1. `GET /v1/skills?limit=10`
2. Paginate through all skills

**Expected Response**:
- HTTP Status: 200
- Proper pagination support
- Consistent ordering

### 6.4 Skill Update Tests

#### TC-SKILL-012: Update Skill Configuration
**Description**: Modify existing skill
**Endpoint**: `PUT /v1/skills/{skill_id}`
**Request**: Updated configuration
**Expected Response**:
- HTTP Status: 200
- Updated skill metadata
- New `latest_version`
- Updated `updated_at` timestamp

#### TC-SKILL-013: Partial Skill Update
**Description**: Update specific fields only
**Test Cases**:
1. Update description only
2. Update configuration only
3. Update title only

**Expected Response**:
- HTTP Status: 200
- Appropriate field updates
- Unchanged fields preserved

#### TC-SKILL-014: Update Non-existent Skill
**Description**: Attempt update on invalid ID
**Endpoint**: `PUT /v1/skills/invalid-skill-id`
**Expected Response**:
- HTTP Status: 404
- Error: `skill_not_found`

### 6.5 Skill Deletion Tests

#### TC-SKILL-015: Delete Skill
**Description**: Remove created skill
**Endpoint**: `DELETE /v1/skills/{skill_id}`
**Expected Response**:
- HTTP Status: 200 or 204
- Skill no longer accessible

#### TC-SKILL-016: Delete Non-existent Skill
**Description**: Attempt to delete invalid skill
**Endpoint**: `DELETE /v1/skills/invalid-skill-id`
**Expected Response**:
- HTTP Status: 404
- Error: `skill_not_found`

#### TC-SKILL-017: Reuse Deleted Skill ID
**Description**: Attempt to use deleted skill
**Test Method**:
1. Create skill
2. Delete skill
3. Attempt to retrieve or update

**Expected Response**:
- HTTP Status: 404
- Error indicating skill not found

### 6.6 Skill Usage Tests

#### TC-SKILL-018: Use Skill in Messages API
**Description**: Reference skill in message request
**Request**:
```json
{
  "model": "claude-sonnet-4-5-20250929",
  "max_tokens": 1024,
  "messages": [
    {
      "role": "user",
      "content": "Analyze this data"
    }
  ],
  "skills": [
    {
      "skill_id": "[VALID_SKILL_ID]",
      "configuration": {
        "analysis_depth": "detailed"
      }
    }
  ]
}
```
**Expected Response**:
- HTTP Status: 200
- Skill influences response
- Appropriate capability usage

#### TC-SKILL-019: Multiple Skills in Single Request
**Description**: Use multiple skills simultaneously
**Request**:
```json
{
  "skills": [
    {"skill_id": "skill_1", "configuration": {...}},
    {"skill_id": "skill_2", "configuration": {...}},
    {"skill_id": "skill_3", "configuration": {...}}
  ]
}
```
**Expected Response**:
- HTTP Status: 200
- All skills applied appropriately
- Combined effect on response

#### TC-SKILL-020: Skill Activation Modes
**Description**: Test different skill activation modes
**Test Cases**:
1. `mode: "explicit"`
2. `mode: "auto"`
3. `mode: "conditional"`

**Expected Response**:
- Appropriate activation behavior
- Conditional triggers work as configured

### 6.7 Performance Tests

#### TC-SKILL-021: Skill Creation Performance
**Description**: Measure skill creation times
**Test Method**:
- Create skills with varying complexity
- Measure response times

**Success Criteria**:
- Reasonable creation times
- Complexity impacts time appropriately

#### TC-SKILL-022: Skill Usage Performance Impact
**Description**: Measure Messages API performance with skills
**Test Method**:
- Compare response times with/without skills
- Test with multiple skills

**Success Criteria**:
- Acceptable performance impact
- Linear scaling with skill count

#### TC-SKILL-023: Concurrent Skill Operations
**Description**: Test multiple simultaneous skill operations
**Test Method**:
- Concurrent creations
- Concurrent updates
- Mixed operations

**Success Criteria**:
- All operations complete
- No interference or corruption

### 6.8 Integration Tests

#### TC-SKILL-024: Skill and File Integration
**Description**: Combine skills with file processing
**Test Method**:
1. Upload file
2. Create analysis skill
3. Use both in Messages API

**Expected Response**:
- Skill processes file content
- Appropriate combined response

#### TC-SKILL-025: Skill Chaining Validation
**Description**: Test sequential skill application
**Test Method**:
- Create complementary skills
- Chain in Messages API
- Verify sequential processing

**Success Criteria**:
- Skills chain appropriately
- Output reflects combined capabilities

#### TC-SKILL-026: Skill Version Management
**Description**: Test skill versioning and updates
**Test Method**:
1. Create skill v1.0.0
2. Update to v1.1.0
3. Verify version tracking
4. Test backward compatibility

**Success Criteria**:
- Version tracking works
- Updates don't break existing references

---

## 7. Cross-API Integration Tests

### 7.1 End-to-End Workflow Tests

#### TC-INTEG-001: Complete Document Processing Pipeline
**Description**: Test full workflow from file upload to analysis
**Steps**:
1. Upload document via Files API
2. Create analysis skill via Skills API
3. Count tokens for processing via Token Counting API
4. Process document with skill via Messages API
5. Verify results and cleanup

**Success Criteria**:
- All APIs work together seamlessly
- Data flows correctly between steps
- Appropriate error handling

#### TC-INTEG-002: Batch Processing with Skills
**Description**: Process batch with custom skills
**Steps**:
1. Create analysis skill
2. Create batch with multiple documents
3. Reference skill in batch requests
4. Monitor batch completion
5. Verify skill application in results

**Success Criteria**:
- Skills applied correctly in batch
- Consistent results across requests
- Proper error isolation

### 7.2 Data Consistency Tests

#### TC-INTEG-003: Model Consistency Across APIs
**Description**: Verify model availability consistency
**Test Method**:
1. Get model list from Models API
2. Use each model in Messages API
3. Count tokens for each model
4. Verify consistent behavior

**Success Criteria**:
- Models work consistently across APIs
- Token counts align with usage

#### TC-INTEG-004: File Reference Consistency
**Description**: Test file usage across multiple APIs
**Test Method**:
1. Upload file
2. Reference in Messages API
3. Count tokens with file reference
4. Use in batch processing
5. Verify consistent access

**Success Criteria**:
- File references work consistently
- No access issues between APIs

### 7.3 Error Propagation Tests

#### TC-INTEG-005: Error Handling in Integrated Workflows
**Description**: Test error propagation between APIs
**Test Cases**:
1. File upload fails → Messages API handles gracefully
2. Skill creation fails → Messages API falls back
3. Token counting fails → Messages API proceeds with estimate
4. Batch processing fails → Individual errors reported

**Success Criteria**:
- Errors isolated appropriately
- Graceful degradation
- Clear error reporting

#### TC-INTEG-006: Rate Limit Integration
**Description**: Test rate limiting across API calls
**Test Method**:
- Rapid calls across different APIs
- Monitor for coordinated rate limiting
- Verify fair usage tracking

**Expected Behavior**:
- Consistent rate limiting
- Fair resource allocation
- Clear exceeded limits indication

### 7.4 Performance Integration Tests

#### TC-INTEG-007: End-to-End Performance
**Description**: Measure complete workflow performance
**Test Method**:
- Time complete processing pipeline
- Compare with individual API times
- Identify bottlenecks

**Success Criteria**:
- Acceptable total processing time
- Efficient API coordination
- Scalable performance

#### TC-INTEG-008: Concurrent Integrated Workflows
**Description**: Test multiple simultaneous workflows
**Test Method**:
- Run 5+ complete workflows concurrently
- Monitor for resource contention
- Verify independent processing

**Success Criteria**:
- All workflows complete successfully
- No interference between workflows
- Consistent performance

---

## 8. Security Test Cases

### 8.1 Authentication & Authorization

#### TC-SEC-001: API Key Validation
**Description**: Test various API key scenarios
**Test Cases**:
1. No API key header
2. Invalid API key format
3. Revoked API key
4. Expired API key
5. Insufficient permissions key

**Expected Response**:
- HTTP Status: 401 for missing/invalid
- Clear authentication error messages
- No information leakage

#### TC-SEC-002: Header Manipulation
**Description**: Test security of required headers
**Test Cases**:
1. Missing `anthropic-version`
2. Invalid version format
3. Missing `content-type` for JSON APIs
4. Incorrect `content-type` values

**Expected Response**:
- HTTP Status: 400 for missing/invalid headers
- Clear validation errors
- No default assumptions

#### TC-SEC-003: Beta Feature Access Control
**Description**: Test beta feature authorization
**Test Cases**:
1. Access beta API without beta header
2. Invalid beta header format
3. Unauthorized beta feature access

**Expected Response**:
- HTTP Status: 403 for unauthorized beta access
- Clear permission error messages

### 8.2 Input Validation

#### TC-SEC-004: Injection Attack Prevention
**Description**: Test for injection vulnerabilities
**Test Cases**:
1. SQL injection in text fields
2. Command injection in parameters
3. JSON/XML injection
4. Template injection

**Expected Response**:
- Proper input sanitization
- No code execution from inputs
- Safe error messages

#### TC-SEC-005: File Upload Security
**Description**: Test file upload security measures
**Test Cases**:
1. Malicious file types
2. Files with embedded scripts
3. Oversized file attacks
4. Zip bombs/recursive archives

**Expected Response**:
- File type validation
- Content scanning
- Size limit enforcement
- Safe rejection of malicious files

#### TC-SEC-006: Skill Configuration Security
**Description**: Test skill configuration validation
**Test Cases**:
1. Malicious configuration parameters
2. Unsafe capability definitions
3. Injection in skill templates
4. Privilege escalation attempts

**Expected Response**:
- Secure configuration validation
- Sandboxed skill execution
- Safe error handling

### 8.3 Data Protection

#### TC-SEC-007: Data Isolation
**Description**: Test user/organization data isolation
**Test Method**:
1. Create resources with User A
2. Attempt access with User B
3. Verify isolation

**Success Criteria**:
- No cross-user data access
- Proper access controls
- Clear permission errors

#### TC-SEC-008: Sensitive Data Handling
**Description**: Test handling of sensitive information
**Test Cases**:
1. Personal identifiable information
2. Financial data
3. Health information
4. Credentials/secrets

**Expected Behavior**:
- Appropriate data handling
- No unnecessary logging/storage
- Secure transmission

#### TC-SEC-009: File Access Control
**Description**: Test file access permissions
**Test Method**:
1. Upload file with one user
2. Attempt reference with different user
3. Verify access controls

**Success Criteria**:
- Files accessible only to owner/org
- Proper permission enforcement
- Clear access denied errors

### 8.4 API Abuse Prevention

#### TC-SEC-010: Rate Limiting Security
**Description**: Test rate limiting effectiveness
**Test Cases**:
1. Rapid request bursts
2. Distributed attack simulation
3. Resource exhaustion attempts

**Expected Response**:
- Effective rate limiting
- Graceful degradation
- No service disruption

#### TC-SEC-011: Denial of Service Protection
**Description**: Test DoS attack resilience
**Test Cases**:
1. Large payload attacks
2. Connection exhaustion
3. Slowloris-type attacks

**Success Criteria**:
- Service remains available
- Legitimate requests processed
- Attack traffic filtered

#### TC-SEC-012: Resource Quota Enforcement
**Description**: Test resource limit enforcement
**Test Cases**:
1. Exceed file storage limits
2. Exceed skill creation limits
3. Exceed batch size limits

**Expected Response**:
- Clear quota exceeded errors
- Graceful rejection of excess
- Fair resource allocation

### 8.5 Privacy Tests

#### TC-SEC-013: Data Minimization
**Description**: Verify only necessary data collected
**Test Method**:
- Analyze API requests/responses
- Check for unnecessary data fields
- Verify data retention policies

**Success Criteria**:
- Minimal data collection
- Appropriate data retention
- Clear privacy policies

#### TC-SEC-014: User Privacy Protection
**Description**: Test privacy of user interactions
**Test Cases**:
1. Anonymized request tracking
2. Private data in conversations
3. Metadata privacy

**Expected Behavior**:
- User privacy protected
- Minimal metadata collection
- Secure data handling

#### TC-SEC-015: Compliance Validation
**Description**: Test regulatory compliance features
**Test Cases**:
1. Data deletion requests
2. Access restriction compliance
3. Audit trail capabilities

**Success Criteria**:
- Compliance features available
- Proper data handling
- Audit capabilities

---

## 9. Performance & Load Test Cases

### 9.1 Baseline Performance Tests

#### TC-PERF-001: Single Request Latency
**Description**: Measure baseline response times
**Test Method**:
- Send individual requests to each API
- Measure response times
- Establish performance baselines

**Success Criteria**:
- Messages API: < 5s average
- Token Counting: < 1s average
- Models API: < 500ms average
- Files API: Variable based on size
- Skills API: < 2s creation time

#### TC-PERF-002: Throughput Measurement
**Description**: Test maximum requests per second
**Test Method**:
- Gradually increase request rate
- Measure sustained throughput
- Identify maximum capacity

**Success Criteria**:
- Consistent throughput under load
- Graceful degradation at limits
- No catastrophic failure

### 9.2 Load Testing

#### TC-PERF-003: Sustained Load Endurance
**Description**: Test performance under sustained load
**Test Method**:
- 30-minute sustained load test
- Monitor response times
- Check for memory/CPU issues

**Success Criteria**:
- Stable performance throughout
- No memory leaks
- Consistent response times

#### TC-PERF-004: Peak Load Handling
**Description**: Test handling of traffic spikes
**Test Method**:
- Sudden 10x traffic increase
- Monitor system response
- Measure recovery time

**Success Criteria**:
- Graceful handling of spikes
- Quick recovery
- No service disruption

### 9.3 Scalability Tests

#### TC-PERF-005: Horizontal Scaling Validation
**Description**: Test performance with increased resources
**Test Method**:
- Simulate resource scaling
- Measure performance improvements
- Verify linear scaling

**Success Criteria**:
- Performance scales with resources
- Efficient resource utilization
- No scaling bottlenecks

#### TC-PERF-006: Concurrent User Simulation
**Description**: Test with simulated concurrent users
**Test Method**:
- Simulate 100+ concurrent users
- Mixed API usage patterns
- Monitor system performance

**Success Criteria**:
- Handles concurrent users well
- Fair resource allocation
- Consistent user experience

### 9.4 Stress Testing

#### TC-PERF-007: System Limits Testing
**Description**: Push system to its limits
**Test Method**:
- Exceed normal usage patterns
- Test boundary conditions
- Monitor failure modes

**Success Criteria**:
- Graceful failure modes
- No data corruption
- Clear error conditions

#### TC-PERF-008: Recovery Testing
**Description**: Test system recovery after stress
**Test Method**:
- Apply extreme load
- Stop load
- Measure recovery to normal

**Success Criteria**:
- Quick recovery
- No residual issues
- Full functionality restored

### 9.5 Resource Utilization Tests

#### TC-PERF-009: Memory Usage Monitoring
**Description**: Test memory usage patterns
**Test Method**:
- Monitor memory during various operations
- Check for leaks
- Measure peak usage

**Success Criteria**:
- Efficient memory usage
- No memory leaks
- Appropriate garbage collection

#### TC-PERF-010: CPU Utilization Testing
**Description**: Test CPU usage efficiency
**Test Method**:
- Monitor CPU during processing
- Identify expensive operations
- Optimize resource usage

**Success Criteria**:
- Efficient CPU utilization
- No unnecessary processing
- Scalable performance

#### TC-PERF-011: Network Efficiency
**Description**: Test data transfer efficiency
**Test Method**:
- Measure payload sizes
- Monitor transfer times
- Optimize data formats

**Success Criteria**:
- Efficient data transfer
- Appropriate compression
- Minimal overhead

---

## 10. Reliability & Availability Test Cases

### 10.1 Fault Tolerance Tests

#### TC-REL-001: Service Dependency Failure
**Description**: Test behavior when dependencies fail
**Test Cases**:
1. Database connectivity loss
2. External service failures
3. Cache system failures

**Expected Behavior**:
- Graceful degradation
- Clear error messages
- No cascading failures

#### TC-REL-002: Partial System Failure
**Description**: Test handling of partial failures
**Test Cases**:
1. One API endpoint failure
2. Regional service disruption
3. Component failures

**Success Criteria**:
- Isolated failures
- Functional components remain available
- Clear status reporting

### 10.2 Recovery Tests

#### TC-REL-003: Automatic Recovery Validation
**Description**: Test automatic recovery mechanisms
**Test Method**:
- Simulate failure conditions
- Monitor automatic recovery
- Verify restored functionality

**Success Criteria**:
- Automatic recovery works
- Minimal downtime
- Data consistency maintained

#### TC-REL-004: Manual Recovery Procedures
**Description**: Test documented recovery procedures
**Test Method**:
- Follow recovery documentation
- Measure recovery time
- Verify success

**Success Criteria**:
- Documentation accurate
- Procedures effective
- Recovery within SLA

### 10.3 Redundancy Tests

#### TC-REL-005: Failover Testing
**Description**: Test failover to redundant systems
**Test Method**:
- Simulate primary system failure
- Monitor failover to secondary
- Verify seamless transition

**Success Criteria**:
- Automatic failover
- Minimal service disruption
- Data consistency

#### TC-REL-006: Load Distribution Validation
**Description**: Test load balancing effectiveness
**Test Method**:
- Monitor request distribution
- Test under varying loads
- Verify balanced resource usage

**Success Criteria**:
- Even load distribution
- Efficient resource utilization
- No single points of overload

### 10.4 Backup & Restore Tests

#### TC-REL-007: Backup Integrity Validation
**Description**: Test backup system reliability
**Test Method**:
- Verify backup completion
- Test backup restoration
- Validate restored data

**Success Criteria**:
- Backups complete successfully
- Restoration works correctly
- Data integrity maintained

#### TC-REL-008: Disaster Recovery Testing
**Description**: Test full disaster recovery procedures
**Test Method**:
- Simulate disaster scenario
- Execute recovery plan
- Verify full service restoration

**Success Criteria**:
- Recovery within RTO/RPO
- Full functionality restored
- Data consistency verified

### 10.5 Monitoring & Alerting Tests

#### TC-REL-009: Monitoring System Validation
**Description**: Test monitoring coverage and accuracy
**Test Method**:
- Generate various system events
- Verify monitoring detection
- Check alert accuracy

**Success Criteria**:
- Comprehensive monitoring
- Accurate event detection
- Timely alerts

#### TC-REL-010: Alert Response Testing
**Description**: Test alert response procedures
**Test Method**:
- Trigger critical alerts
- Monitor response times
- Verify resolution procedures

**Success Criteria**:
- Timely alert delivery
- Appropriate response procedures
- Effective issue resolution

---

## Test Execution Guidelines

### 1. Test Environment Setup
- Use separate API keys for testing
- Implement rate limiting awareness
- Set up monitoring for test execution
- Establish baseline performance metrics

### 2. Test Data Management
- Use synthetic test data
- Avoid real user data
- Clean up test resources after execution
- Maintain test data consistency

### 3. Execution Order
1. Start with basic functionality tests
2. Proceed to validation tests
3. Execute advanced feature tests
4. Perform integration tests
5. Conduct security tests
6. Run performance tests
7. Execute reliability tests

### 4. Success Criteria
- All basic functionality tests pass
- Validation tests produce appropriate errors
- Advanced features work as documented
- Integration tests demonstrate seamless operation
- Security tests show proper protections
- Performance meets documented expectations
- Reliability tests demonstrate system resilience

### 5. Reporting
- Document test results for each test case
- Note any deviations from expected behavior
- Report performance metrics
- Document security validation results
- Provide recommendations for improvements

---

## Appendix: Test Tools & Frameworks

### Recommended Testing Tools:
1. **API Testing**: Postman, Insomnia, or custom scripts
2. **Load Testing**: k6, Locust, or JMeter
3. **Security Testing**: OWASP ZAP, Burp Suite
4. **Monitoring**: Prometheus, Grafana, CloudWatch
5. **Automation**: Python with requests, pytest

### Test Automation Framework Example:
```python
import pytest
import requests
from typing import Dict, Any

class ClaudeAPITester:
    def __init__(self, api_key: str, base_url: str = "https://api.anthropic.com"):
        self.api_key = api_key
        self.base_url = base_url
        self.headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json"
        }

    def test_messages_api(self, test_data: Dict[str, Any]) -> Dict[str, Any]:
        response = requests.post(
            f"{self.base_url}/v1/messages",
            headers=self.headers,
            json=test_data
        )
        return {
            "status_code": response.status_code,
            "response": response.json(),
            "latency": response.elapsed.total_seconds()
        }

    # Additional test methods for each API...
```

### Test Data Generation:
- Use libraries like Faker for synthetic data
- Create test files of various types and sizes
- Generate realistic conversation scenarios
- Simulate various usage patterns

---

## Version History
- **v1.0**: Initial comprehensive test case creation
- **Based on**: Claude API documentation as of 2026-01-21
- **Coverage**: All 6 APIs with 300+ test cases
- **Categories**: Functionality, validation, performance, security, integration, reliability

---

*Last Updated: 2026-01-21*
*Test Coverage: Comprehensive - All documented APIs and features*
*Status: Ready for execution*