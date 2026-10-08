---
title: Getting Started
description: Quick start guides and basic configuration
---

# Getting Started

Welcome to Model Proxy v3! This section covers the basics to get you up and running quickly.

## Guides

- [Configuration Guide](./configuration-guide.md) — Minimal `proxy_config.toml` walkthrough with model categories, `upstream_mode`, per-model overrides, wildcards, and extended thinking/reasoning notes
- [Example Configuration](./proxy_config.example.toml) — Fully commented config covering every section and option
- [README Details](./README_DETAILS.md) — Additional details from the main README

## Quick Start

1. **Install**: `git clone <repo-url> && cd model_proxy_v3 && npm install`
2. **Configure**: `cp docs/getting-started/proxy_config.example.toml proxy_config.toml` and edit
3. **Run**: `npm run server` — starts on http://localhost:8788
4. **Test**: Send a request to `/v1/messages` with your API key

## Next Steps

- [Model Routing & Aliases](../reference/routing-and-aliases.md) — Full routing reference
- [API Endpoints](../api/api-endpoints.md) — All endpoint details
- [Configuration Reference](../reference/configuration-reference.md) — Complete field-by-field reference
- [Agent Integrations](../guides/agents/) — Per-agent setup guides