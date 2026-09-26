---
title: Architecture
description: Design documents, architectural decisions, and planning documents
---

# Architecture

Design documents, architectural decisions, and planning documents for Model Proxy v3.

## Core Design Documents

- [Design: Coordinator](./design_and_plan_of_coordinator.md) — Planner→Executor coordinator composite alias design
- [Design: Fusion Composite Alias](./design_fusion_composite_alias.md) — Fusion fan-out with panel models, judge, and synthesis
- [Design: Passthrough Mode](./design_passthrough_mode.md) — Verbatim relay mode (`/passthrough`) design
- [Design: Request Transform Hooks](./design_request_transform_hooks.md) — Original design for request/response transform hooks
- [Design: Tauri Tray](./design_tauri_tray.md) — System tray app design (external repo: proxy_tray)

## Implementation Architecture

- [Model Routing Implementation](./model_routing_implementation.md) — Routing hierarchy, lookup logic, and implementation details
- [Multiple Upstream Analysis](./multiple_upstream_analysis.md) — Analysis of multi-upstream routing strategies
- [Proxy Implementation](./proxy_impementation.md) — Core proxy architecture (note: filename typo "impementation")
- [Proxy Plan for v3](./proxy_plan_for_v3.md) — Original v3 implementation plan (phases 0-6)

## Routing Architecture

- [Routing Review](./routing-review.md) — Transform route tradeoffs and recommendations
- [Routing Refactor](./routing_refactor.md) — Routing refactoring notes
- [Routing Config Revision](./routing_config_revision.md) — Configuration revision for routing

## Planning Documents

### Feature Plans
- [Plan: LLM as Verifier Plugin](./plan-llm-as-a-verifier-plugin.md)
- [Plan: OPF Privacy Filter Plugin](./plan-opf-privacy-filter-plugin.md)
- [Plan: Remote Target Retry Dispatch](./plan-remote-target-retry-dispatch.md)
- [Plan: Split Cloudflare Worker vs Local](./plan-split-cloudflare-worker-vs-local.md)
- [Plan: Refactor Divide Proxy for Local/Server Side](./plan-to-refactor-divide-proxy-for-local-side-and-server-side.md)

### Proposals
- [Proposal: DeepSeek Harness LLM Split](./proposal-deepseek-harness-llm-split.md)
- [Proposal: Zod Schema Validation](./proposal-zod-schema-validation.md)

### Spec Compliance
- [TODO: Composite Fusion TOML Spec Compliance](./todo-composite-fusion-toml-spec-compliance.md)

## Related

- [Request/Response Transforms](../reference/transforms-reference.md) — Current transform hooks reference
- [Routing & Aliases](../reference/routing-and-aliases.md) — Full routing reference
- [Configuration Reference](../reference/configuration-reference.md) — Complete configuration reference