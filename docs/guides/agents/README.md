---
title: Agent Integrations
description: Per-agent guides for using Model Proxy v3 as an LLM provider
---

# Agent Integrations

Guides for configuring various AI agents and frameworks to use Model Proxy v3 as their LLM provider.

## Available Integrations

- [GitHub Copilot CLI](./copilot-cli.md) — Use the proxy with GitHub Copilot CLI
- [CrewAI](./crewai.md) — Multi-agent framework integration
- [Google Antigravity](./google-antigravity.md) — Google's Antigravity agent
- [Harness Agent](./harness-agent.md) — Harness CI/CD agent integration
- [LangGraph](./langgraph.md) — LangGraph stateful agent framework
- [OpenCode](./opencode.md) — OpenCode agent integration
- [Proxy as Provider for DeepSeek Harness](./proxy-as-provider-for-deepseek-harness.md) — Using the proxy with DeepSeek's harness

## Quick Start

Most agents can be configured by setting the proxy's base URL and using a compatible API format:

```bash
# Example: Configure agent to use proxy
export OPENAI_BASE_URL=http://localhost:8788/v1
export ANTHROPIC_BASE_URL=http://localhost:8788
```

See individual agent guides for specific configuration details.