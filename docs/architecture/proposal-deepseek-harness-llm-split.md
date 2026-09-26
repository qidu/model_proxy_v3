# Proposal: make self-hosted gateways first-class providers in deepseek-harness (split `packages/llm`)

*Addressed to the deepseek-harness maintainers. Written from the perspective of
[model_proxy_v3](https://github.com/qidu/model_proxy_v3) — an open-source,
self-hosted multi-protocol LLM proxy — after a verified end-to-end integration
with dsh.*

## TL;DR

The [`packages/llm`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm)
layer wraps `@earendil-works/pi-ai` to reach LLM providers, the same role
`openclaw` filled. It works, but the provider picker is dominated by a long
catalog of third-party SaaS providers, and model choices are limited to what
those external catalogs ship. We propose splitting the provider layer so that
**self-hosted gateways** (model_proxy_v3, LiteLLM, one-api, OpenRouter-style
routers) can plug in as first-class providers — one picker entry, live model
sync from the gateway's own listing, and no dependence on an external project's
catalog.

We have already validated the integration path with zero dsh code changes:
[How to set a 3rd party proxy for deepseek-harness](https://github.com/qidu/model_proxy_v3/blob/feature/transforms_hooks/docs/guides/agents/proxy-as-provider-for-deepseek-harness.md).

## The current pain

1. **The provider list is long and catalog-bound.** A hand-declared route in
   `llm-pi-ai.providers` works today, but in the configuration surface it sits
   alongside ~20 catalog providers. Users hunting for their gateway scroll past
   providers they will never use.
2. **Models are limited by the third-party catalog.** A route keyed to an
   installed pi-ai provider inherits that provider's model list; a hand-declared
   route must be hand-maintained model-by-model in `settings.yaml`.
3. **Discovery is OpenAI-only.** `discoverModels` interrogates
   `GET {baseURL}/models` only for `openai-completions` / `openai-responses`
   routes. Gateways that speak Anthropic's protocol (and serve Anthropic-shaped
   `/v1/models` listings — model_proxy_v3 does) cannot be interrogated at all,
   even though their listings carry exactly the fields the parser reads
   (`data[].id`, `display_name`).
4. **Nothing carries capabilities.** A discovered model has no
   `contextWindow` / `maxTokens` unless the user types them; the defaults
   (262k / 32k) silently mis-size real models.

## What self-hosted gateways bring to dsh users

[It even works for all other agents](https://github.com/qidu/model_proxy_v3/tree/feature/transforms_hooks)
— model_proxy_v3 gives any OpenAI/Anthropic/Gemini-speaking client the routing
features commercial platforms (e.g. OpenRouter) sell, entirely server-side and
transparent to the client:

- **Composite alias** — one model id fanned across multiple upstreams with
  share weights and fallbacks (e.g. `code-small` = glm + claude pool).
- **Fusion** — parallel panel/judge/synthesis fan-out behind a single model id.
- **Coordinator** — automatic planner/executor model switching based on
  conversation stage.
- **Schedule** — time-of-day/day-of-week routing targets.
- **Transforms** — per-route request/response rewriting for upstream quirks,
  plus key management: the gateway holds upstream credentials; clients use a
  dummy key.

None of this requires anything from dsh today — the proxy absorbs provider
heterogeneity, protocol conversion, and credential storage, and dsh just talks
to one endpoint. That is precisely the argument for treating gateways as a
*tier*, not as "one more provider among twenty".

## Plugin system over bundled provider modules

It is already easy to drive existing LLM agents — Claude Code, Codex, opencode —
to a custom LLM provider: they accept a base URL and a key, and are running
against a gateway in minutes (see [`../guides/agents/`](../guides/agents/) for worked
examples against this proxy). New agents such as deepseek-harness should not
have to re-solve this problem by bundling ever-larger modules that chase
evolving third-party LLM providers.

As a plugin system, dsh needs only a small, stable LLM contract:

- **Third-party providers churn; the contract shouldn't.** New providers,
  renamed models, protocol extensions, and auth schemes appear weekly. When
  each is a plugin, the churn is absorbed by whoever owns the integration —
  not by the harness core, and not by one shared dependency (the pi-ai catalog)
  that every route inherits.
- **A gateway plugin replaces N provider plugins.** Point dsh at one
  self-hosted gateway and every upstream it fronts — including future ones —
  is reachable through a single registration with live model sync. The harness
  ships none of the provider-specific code.
- **The picker and the codebase stay small.** The provider list stops growing
  with the market; surface complexity scales with what the user actually
  configured, not with the number of providers that exist.

This is the same bet dsh already made architecturally (everything is a Cordis
plugin); the proposal is to finish it at the `packages/llm` seam.

## The proposal

Split `packages/llm` along the seam that already exists:

1. **Keep `@deepseek-ai/dsh-llm` as the contract.** Adapter registration,
   discovery types (`LlmDiscoveredModel`), credential seams — this is already a
   clean interface.
2. **Make `llm-pi-ai` one implementation of that contract, not the only one.**
   External projects should be able to ship a provider plugin that registers
   routes, answers model discovery, and reports capabilities without going
   through pi-ai's catalog.
3. **Add a "gateway" tier to the configuration surface.** A gateway is one
   picker entry with N models — chosen from a live listing, not a global
   catalog. Collapsing gateway routes under their gateway shrinks the provider
   picker and matches how users think ("my proxy", then "which model").
4. **Generalize discovery beyond the OpenAI shape.** Accept Anthropic-shaped
   listings (`data[].id` + `display_name` + `first_id`/`has_more`) for
   `anthropic-messages` routes, and read common capacity extensions
   (`context_window` / `context_length`, `max_output_tokens`) when present.
   model_proxy_v3's `/v1/models` already returns a compatible shape, verified
   against `discoverModels` as-is.
5. **Sync, not just probe.** "Fetch available models" currently offers
   candidates for manual adoption. A gateway route could optionally reconcile
   its model list on demand (still user-confirmed), since the gateway — not an
   external catalog — is the authority for what it serves.

## Evidence the integration already works

Against `model_proxy_v3` running as a plain local process, on stock dsh:

- **OpenAI-compatible route**: `api: openai-completions`,
  `baseURL: http://<proxy>/v1`, dummy key — headless dsh runs end-to-end.
- **Model discovery**: invoking dsh's own `discoverModels` against the proxy
  returned **all 23 configured models** — concrete entries, composite/fusion/
  coordinator aliases, and schedule aliases — with no dsh modifications.
- **Anthropic route**: `api: anthropic-messages` also works for chat; only
  discovery is blocked (point 3 above).

Full config examples (both protocols) and caveats are in
[docs/guides/agents/proxy-as-provider-for-deepseek-harness.md](https://github.com/qidu/model_proxy_v3/blob/feature/transforms_hooks/docs/guides/agents/proxy-as-provider-for-deepseek-harness.md).

## What we offer

- model_proxy_v3 can ship and maintain a dsh provider plugin (or a thin
  gateway descriptor) once the contract is split out.
- We can contribute the Anthropic-shaped listing support in `discovery.ts` —
  the parser already reads the right fields; the change is small and localized.
- We will keep the integration doc above tested against dsh releases, the same
  way `docs/guides/agents/` covers other agent harnesses (opencode, copilot-cli,
  crewai, langgraph).

## Summary

dsh's plugin architecture made this integration possible without touching dsh
source — that is a strength worth building on. Splitting the provider layer so
gateways are a first-class tier turns "a hand-declared route that happens to
work" into a supported path, gives users OpenRouter-class routing from
self-hosted software, and keeps the provider picker short and honest about
where models actually come from.
