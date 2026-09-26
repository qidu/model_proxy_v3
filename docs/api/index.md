---
title: API Reference
description: API endpoint details, format references, and schema documentation
---

# API Reference

Complete API documentation for Model Proxy v3 endpoints, request/response formats, and schema references.

## Endpoint Documentation

- [API Endpoints](./api-endpoints.md) — All endpoints: dynamic routing, image I/O, prompt caching, Dashboard API
- [Auth Header Extraction](./auth_header_extraction.md) — How auth headers are extracted and forwarded

## Format References

### Client API Formats (Incoming)
- [Claude API Reference](./claude-api-reference.md) — `/v1/messages`, `/v1/messages/count_tokens`
- [Gemini API Reference](./gemini-api-reference.md) — `/v1beta/models/{model}:generateContent`, `:streamGenerateContent`, `:countTokens`, `/v1/interactions`
- [OpenAI API Reference](./openai-api-reference.md) — `/v1/responses`, `/v1/chat/completions`, `/v1/embeddings`

### Upstream API Formats (Outgoing)
- [Claude API Reference](./claude-api-reference.md) — Anthropic Messages API
- [Gemini API Reference](./gemini-api-reference.md) — GenerateContent & Interactions APIs
- [OpenAI API Reference](./openai-api-reference.md) — Chat Completions & Responses APIs
- [Vertex AI Gemini API](./vertex-ai-gemini-api.md) — Vertex AI Gemini endpoint

### Special Topics
- [Claude Beta Headers](./claude-beta-headers.md) — Beta header handling
- [Claude Token Pricing](./claude-token-pricing.md) — Token pricing for Claude models
- [List of APIs and Schemas](./list_of_api_and_schema.md) — Comprehensive API/schema inventory
- [OpenRouter Skill](./openrouter_skill.md) — OpenRouter integration
- [OpenRouter Tool Calling](./openrouter_tool_calling.md) — Tool calling with OpenRouter

### Claude Thinking Formats
- [Claude Extended Thinking](./claude-extended-thinking.md) — Extended thinking blocks, tag-based and `reasoning_content` extraction
- [Claude Adaptive Thinking](./claude-adaptive-thinking.md) — Adaptive thinking budget management

## OpenAI API Documentation (Detailed)

- [OpenAI Responses API](./openai-response.md) — `/v1/responses` create, cancel, and related endpoints
- [OpenAI Responses: Create Method](./openai-response-methods-create.md) — Detailed request/response for create
- [OpenAI Responses: Token Counting](./openai-response-token-counting.md) — Token counting for responses
- [OpenAI Responses: Additional Endpoints](./openai-response-final.md) — Cancel and other endpoints
- [OpenAI Responses: Additional Tools Example](./openai-response-additional-tools-example.md) — `additional_tools` parsed schema example
- [OpenAI Prompt Caching](./openai-prompt-caching.md) — Prompt caching with OpenAI-compatible upstreams

## Claude API Documentation (Detailed)

The [`claude_api_docs/`](./claude_api_docs/) folder contains detailed reference for the Anthropic Claude API:

- [Overview](./claude_api_docs/overview.md)
- [Authentication](./claude_api_docs/authentication.md)
- [Messages API](./claude_api_docs/messages-api.md)
- [Messages Create](./claude_api_docs/messages-create.md)
- [Messages Count Tokens](./claude_api_docs/messages-count-tokens.md)
- [Models API](./claude_api_docs/models-api.md)
- [Batches API](./claude_api_docs/batches-api.md)
- [Files API](./claude_api_docs/files-api.md)
- [Token Counting API](./claude_api_docs/token-counting-api.md)
- [Client SDKs](./claude_api_docs/client-sdks.md)
- [Rate Limits](./claude_api_docs/rate-limits.md)
- [Skills API](./claude_api_docs/skills-api.md)
- [Versioning](./claude_api_docs/versioning.md)
- [Examples](./claude_api_docs/examples/)

## Related

- [Getting Started](../getting-started/) — Quick start and configuration guide
- [Routing & Aliases](../reference/routing-and-aliases.md) — Model routing deep-dive
- [Configuration Reference](../reference/configuration-reference.md) — Complete configuration reference