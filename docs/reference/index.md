---
title: Reference
description: Detailed reference documentation for configuration, protocols, and internals
---

# Reference

Detailed reference documentation for configuration, protocols, and internal mechanisms.

## Configuration

- [Configuration Reference](../configuration-reference.md) — Complete field-by-field reference for all TOML sections and environment variables
- [Config Loader](./config_loader.md) — Configuration loading mechanism, sources (local, Consul, Apollo), and precedence
- [Config Env Removal](./config_env_removal.md) — Environment variable removal/cleanup details

## Protocols & Interfaces

- [Auth & Stats Service Protocol](../architecture/auth-stats-protocol.md) — Wire-level contract for remote auth/stats sidecars
- [Routing & Aliases](./routing-and-aliases.md) — Full `[models.*]` / `[composite]` / `[schedule]` / token-limit reference

## Transforms & Hooks

- [Transforms Reference](./transforms-reference.md) — Current reference: hooks, Tier-1 ops, Tier-2 built-ins, `[transforms.*]` / `[transform_defaults]` config

## Token Counting

- [Token Counting](./token_counting.md) — Token counting implementation across formats

## Deployment & Infrastructure

- [CPU Optimization Advices](./cpu-optimization-advices.md) — Performance optimization notes
- [Nginx Configuration](./nginx_conf/) — Nginx Lua/plain auth configuration examples
  - [Lua Auth Usage](./nginx_conf/nginx_lua_auth/USAGE.md)
  - [Lua Auth Script](./nginx_conf/nginx_lua_auth/auth.lua)
  - [Lua Auth Keys](./nginx_conf/nginx_lua_auth/auth_keys.json)
  - [Plain Auth Usage](./nginx_conf/nginx_plain_auth/USAGE.md)
  - [Plain Auth Map](./nginx_conf/nginx_plain_auth/nginx_auth_map.conf)
  - [Plain Auth HTTP](./nginx_conf/nginx_plain_auth/nginx_http.conf)

## Related

- [Getting Started](../getting-started/) — Quick start and minimal config walkthrough
- [Architecture](../architecture/) — Design documents and planning
- [API Reference](../api/) — Endpoint details and format references