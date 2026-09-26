---
title: Guides
description: How-to guides, integration tutorials, and feature deep-dives
---

# Guides

Practical guides for integrating Model Proxy v3 with various clients and using specific features.

## Agent Integrations

- [Agents Index](./agents/README.md) — Overview of all agent integrations
- [GitHub Copilot CLI](./agents/copilot-cli.md)
- [CrewAI](./agents/crewai.md)
- [Google Antigravity](./agents/google-antigravity.md)
- [Harness Agent](./agents/harness-agent.md)
- [LangGraph](./agents/langgraph.md)
- [OpenCode](./agents/opencode.md)
- [Proxy as Provider for DeepSeek Harness](./agents/proxy-as-provider-for-deepseek-harness.md)

## Feature Guides

### Streaming & Thinking
- [DeepSeek Thinking](./deepseek_thinking.md) — DeepSeek thinking/reasoning support
- [Mono Thinking](./mono-thinking.md) — Unified thinking handling
- [Streaming Thinking Response Processing](./streaming_thinking_response_processing.md) — Processing thinking in streaming responses

### Caching & Content
- [Cached Content Support](./cached_content_support.md) — Gemini cached content feature
- [Implementation: Cached Content](./implementation_cached_content.md) — Implementation details

### API Formats & Conversions
- [Gemini SSE Stream Examples](./gemini-sse-stream-examples.md) — SSE streaming with Gemini
- [Gemini GenerateContent Review](./gemini_generatecontent_review.md)
- [Gemini Interactions Streaming Fix](./gemini_interactions_streaming_fix.md)
- [Gemini Messages Streaming Fix](./gemini_messages_streaming_fix.md)
- [GenerateContent SSE Flow Analysis](./generatecontent_sse_flow_analysis.md)
- [Implementation: Gemini Interactions API](./implementation_of_gemini_interactions_api.md)

### Monitoring & Debugging
- [Live Stats](./live-stats.md) — TUI/web dashboard, JSONL usage-dump format, startup stats restoration
- [SSE Streaming Review](./sse_streaming_review.md)
- [StreamGenerateContent Analysis](./streamgeneratecontent_analysis.md)
- [StreamGenerateContent Implementation Summary](./streamgeneratecontent_implementation_summary.md)
- [StreamGenerateContent Simplified Final](./streamgeneratecontent_simplified_final.md)
- [Tools in Responses Examples](./tools_in_resp_examples.md)

### Deployment
- [Consul Server](./consul-server.md) — Consul configuration for remote config

## Reference

- [API Reference](../api/) — API endpoint details and format references
- [Configuration Reference](../reference/configuration-reference.md) — Complete configuration reference
- [Routing & Aliases](../reference/routing-and-aliases.md) — Model routing deep-dive