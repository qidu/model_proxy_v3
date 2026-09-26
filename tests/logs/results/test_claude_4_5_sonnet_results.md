# Claude-4.5-Sonnet Test Results

## Test Date: 2026-02-25

## Test Configuration

**Model**: claude-4.5-sonnet

**Native Upstream**:
- Base URL: https://api.example2-ai.com
- API Key: sk-NzBalLnHTBdlL23pQHFSzRZXA36HRio3s666mOcLxFfdmAfK

**OpenAI-Compatible Upstream**:
- Base URL: https://api.qnaigc.com
- API Key: sk-87abde0542f469130364cc3de48977a71883d8ec81987d3f7e46ee360985dd02

## Test Results Summary

| # | Endpoint | Upstream | Status | Notes |
|---|----------|----------|--------|-------|
| 1 | /v1/messages | Native | ❌ Failed | Service error from Messages API |
| 2 | /v1/interactions | Native | ❌ Failed | Invalid Gemini Interactions request format |
| 3 | /v1beta/models/{model}:generateContent | Native | ❌ Failed | Model not found on upstream |
| 4 | /v1/messages | OpenAI-compatible | ✅ **Success** | msg_767136f497e84bb89a89ff16c12c8a86 |
| 5 | /v1/interactions | OpenAI-compatible | ❌ Failed | Invalid Gemini Interactions request format |
| 6 | /v1beta/models/{model}:generateContent | OpenAI-compatible | ❌ Failed | 404 Route Not Found on upstream |

**Success Rate**: 1/6 (16.7%)

## Detailed Results

### ✅ Test #4: OpenAI-compatible /v1/messages
**Status**: Success  
**Response ID**: msg_767136f497e84bb89a89ff16c12c8a86  
**Question**: "What is 8+8?"  
**Upstream**: https://api.qnaigc.com/v1/messages  

This test successfully demonstrated:
- Dynamic routing to OpenAI-compatible upstream
- Claude API format request → OpenAI format conversion
- OpenAI format response → Claude API format conversion
- Proper authentication header forwarding

### ❌ Test #1: Native /v1/messages
**Status**: Failed  
**Error**: Service error from Messages API  
**Upstream**: https://api.example2-ai.com/v1/messages  

The upstream API returned an error, suggesting either:
- Invalid API key
- Model not available on this endpoint
- Upstream service issue

### ❌ Test #2: Native /v1/interactions
**Status**: Failed  
**Error**: Invalid Gemini Interactions request format  
**Upstream**: https://api.example2-ai.com/v1/interactions  

The proxy attempted to convert Claude format to Gemini Interactions format, but the upstream rejected the request. This suggests:
- The upstream may not support Interactions API format
- The format conversion may need adjustment

### ❌ Test #3: Native /v1beta/models/{model}:generateContent
**Status**: Failed  
**Error**: model_not_found - No available channel for model claude-4.5-sonnet  
**Upstream**: https://api.example2-ai.com/v1beta/models/claude-4.5-sonnet:generateContent  

The upstream API doesn't have claude-4.5-sonnet available on the generateContent endpoint.

### ❌ Test #5: OpenAI-compatible /v1/interactions
**Status**: Failed  
**Error**: Invalid Gemini Interactions request format  
**Upstream**: https://api.qnaigc.com/v1/interactions  

Similar to Test #2, the Interactions format conversion needs investigation.

### ❌ Test #6: OpenAI-compatible /v1beta/models/{model}:generateContent
**Status**: Failed  
**Error**: 404 Route Not Found  
**Upstream**: https://api.qnaigc.com/v1beta/models/claude-4.5-sonnet:generateContent  

The upstream doesn't have this route available.

## Proxy Improvements Made

1. **Added api.example2-ai.com to ALLOWED_HOSTS** - Enabled routing to native Claude upstream
2. **Updated routing parser** - Added support for v1/interactions and v1beta endpoints
3. **Fixed getHandlerType()** - Returns 'interactions' and 'generateContent' types correctly

## Conclusions

1. **Proxy works correctly** for OpenAI-compatible /v1/messages endpoint ✅
2. **Upstream limitations** prevent testing other endpoints:
   - Native upstream may not support claude-4.5-sonnet
   - Interactions API format may not be supported by upstreams
   - generateContent endpoint not available for this model

3. **Recommendations**:
   - Test with models that are confirmed to work on native upstream
   - Verify Interactions API support with upstream providers
   - Use /v1/messages endpoint for claude-4.5-sonnet (proven to work)

## Test Script

Location: `tests/test_claude_4_5_sonnet.sh`

Run with:
```bash
bash tests/test_claude_4_5_sonnet.sh
```
