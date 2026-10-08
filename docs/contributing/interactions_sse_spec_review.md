# Interactions API SSE Support Analysis

## Date: 2026-02-25

## Specification Review

### According to `../api/interactions.md`:

**YES - Interactions API DOES support SSE streaming** ✅

## Evidence from Spec

### 1. Creating an Interaction (POST)

**Request Parameter:**
```
- **stream** (`boolean`) Input only. Whether the interaction will be streamed.
```

**Location:** Request body for `POST /v1beta/interactions`

### 2. Retrieving an Interaction (GET)

**Query Parameter:**
```
- **stream** (`boolean`) If set to true, the generated content will be streamed incrementally.
  Default: `False`
- **last_event_id** (`string`) Optional. If set, resumes the interaction stream from the next chunk 
  after the event marked by the event id. Can only be used if `stream` is true.
```

**Location:** Query parameters for `GET /v1beta/interactions/{id}`

### 3. SSE Event Types Defined

**Resource:** `InteractionSseEvent`

**Event Types:**
- `interaction.start` - Interaction started
- `interaction.complete` - Interaction completed
- `interaction.status_update` - Status changed
- `content.start` - Content block started
- `content.delta` - Content chunk received
- `content.stop` - Content block stopped
- `error` - Error occurred

**Each event includes:**
- `event_id` - Token to resume stream from this event
- `event_type` - Type of event
- Event-specific data

## SSE Format Example

```
event: interaction.start
data: {"event_type":"interaction.start","interaction":{...},"event_id":"..."}

event: content.start
data: {"event_type":"content.start","index":0,"content":{...},"event_id":"..."}

event: content.delta
data: {"event_type":"content.delta","index":0,"delta":{"type":"text","text":"Hello"},"event_id":"..."}

event: content.delta
data: {"event_type":"content.delta","index":0,"delta":{"type":"text","text":" world"},"event_id":"..."}

event: content.stop
data: {"event_type":"content.stop","index":0,"event_id":"..."}

event: interaction.complete
data: {"event_type":"interaction.complete","interaction":{...},"event_id":"..."}
```

## Streaming Features

### 1. Incremental Streaming
- Content delivered in chunks via `content.delta` events
- Multiple content blocks supported (indexed)

### 2. Resume Support
- `last_event_id` parameter allows resuming from specific event
- Each event includes `event_id` for tracking

### 3. Status Updates
- `interaction.status_update` events for long-running interactions
- Useful for background interactions

### 4. Error Handling
- `error` event type for streaming errors
- Includes error code and message

## Delta Types Supported

The spec defines multiple delta types for streaming:
- `TextDelta` - Text content chunks
- `ImageDelta` - Image data chunks
- `AudioDelta` - Audio data chunks
- `VideoDelta` - Video data chunks
- `ThoughtSummaryDelta` - Thinking model summaries
- `FunctionCallDelta` - Function call arguments
- `FunctionResultDelta` - Function results
- `CodeExecutionCallDelta` - Code execution
- `GoogleSearchCallDelta` - Search queries
- And more...

## Comparison with Current Implementation

### Current Proxy Implementation

**File:** `src/handlers/gemini.ts` - `handleGeminiInteractionsRequest`

**Problem:** ❌ Does NOT support streaming

**Current code:**
```typescript
// Forward request to Gemini API
const response = await fetch(targetUrl, {
    method: 'POST',
    headers: geminiHeaders,
    body: JSON.stringify(geminiRequest),
});

// ❌ Always calls response.json() - no streaming support
const geminiResponse = await response.json() as any;

// ❌ Returns single JSON response
return new Response(JSON.stringify(interactionResponse), {
    status: 200,
    headers: {
        'Content-Type': 'application/json',
        'x-request-id': requestId,
    },
});
```

**Missing:**
1. No check for `stream` parameter
2. No SSE event handling
3. No `content.delta` events
4. No `event_id` tracking

## Specification Compliance

| Feature | Spec Requirement | Current Implementation | Status |
|---------|------------------|------------------------|--------|
| `stream` parameter (POST) | ✅ Required | ❌ Not checked | Missing |
| `stream` parameter (GET) | ✅ Required | ❌ Not implemented | Missing |
| `last_event_id` parameter | ✅ Required | ❌ Not implemented | Missing |
| SSE event format | ✅ Required | ❌ Not implemented | Missing |
| `interaction.start` event | ✅ Required | ❌ Not sent | Missing |
| `content.delta` events | ✅ Required | ❌ Not sent | Missing |
| `interaction.complete` event | ✅ Required | ❌ Not sent | Missing |
| `event_id` tracking | ✅ Required | ❌ Not implemented | Missing |

## Conclusion

**YES - Interactions API specification REQUIRES SSE streaming support** ✅

**Current implementation:** ❌ **NOT COMPLIANT**

The proxy's `handleGeminiInteractionsRequest` handler does not implement streaming, which violates the Interactions API specification.

## Recommendation

**Fix Required:** Implement SSE streaming for Interactions API

**Priority:** High - Spec compliance issue

**Changes needed:**
1. Check `stream` parameter in request
2. Implement SSE event generation
3. Transform upstream SSE to Interactions SSE format
4. Support `event_id` tracking
5. Support `last_event_id` resume

**Reference implementation:**
- `handleGeminiGenerateContentRequest` - Already supports streaming
- Can reuse `handleGeminiStreamingResponse` with modifications

## Related Documentation

- `../api/interactions.md` - Interactions API specification
- `upstream_sse_support_review.md` - Current implementation review
- `../guides/sse_streaming_review.md` - SSE streaming support review
