# Status of Sidecars in Model Proxy v3

> **Generated**: 2025-09-28  
> **Source**: `docs/getting-started/proxy_config.example.toml`, `src/utils/config-loader.ts`, and implementation files in `src/utils/`

---

## Overview

All sidecar configurations are defined **inline** in `proxy_config.toml` under named sections (except Kompress, which uses environment variables only). There are no separate sidecar config files. The example config (`proxy_config.example.toml`) contains full documentation for every option.

**Key pattern**: **None of the sidecars use an `enabled = true` flag.** They are activated by the presence of their URL/endpoint configuration:
- Remote Auth: `auth_server` / `record_server` present
- Privacy Filter: `filter_mode` + `filter_url` (sidecar) or `filter_mode = "local"`
- Image Fetch: `image_encode` URL present
- Tool Judge: `judge_url` present
- Kompress: `KOMPRESS_URL` env var present

---

## Sidecar Summary Table

| Sidecar | Config Method | Failure Mode | Key Implementation |
|---------|---------------|--------------|-------------------|
| **Remote Auth** | `[remote]` TOML | **Fail-CLOSED** (401) | `src/index.ts` routing logic |
| **Privacy Filter** | `[privacy_filter]` TOML | **Fail-CLOSED** | `src/utils/privacy-filter.ts` |
| **Image Fetch/Encode** | `[fetch]` TOML | Fail-open (in-process fallback) | `src/utils/image-fetch.ts` |
| **Tool Judge** | `[tool_judge_sidecar]` TOML | **Fail-OPEN** | `src/utils/tool-judge-sidecar.ts` |
| **Kompress** | **Env vars only** (`KOMPRESS_URL`) | **Fail-OPEN** | `src/utils/kompress.ts` |
| **Coordinator** | `[models.coordinator]` TOML | N/A (model selection) | `src/utils/coordinator.ts` |
| **Fusion** | `[models.fusion]` TOML | N/A (orchestration) | Model resolution logic |
| **Composite** | `[models.*]` (type=composite) TOML | N/A (weighted/fallback) | Model resolution logic |
| **Schedule** | `[models.*]` (type=schedule) TOML | N/A (time-based) | Model resolution logic |
| **Transforms** | `[transforms.*]` TOML | Per-op (mostly fail-open) | `src/utils/transforms/*.ts` |

---

## 1. Remote Auth Sidecar (`[remote]`)

**Purpose**: Pre-route authentication gate + optional stats recording + dynamic failover ladder

```toml
[remote]
auth_server = "http://localhost:8081/auth"
record_server = "http://localhost:8081/record"
auth_with_model = false      # Defer until model known (sends x-resource-for)
auth_with_body = false       # Defer with full body (POST + JSON)
max_targets = 16             # Max ladder entries per request
max_target_retries = 1       # Same-rung retries before advancing
record_response_body = false # Include response body in stats
```

**Behavior**:
- **Fail-CLOSED**: Non-2xx, network error, or missing `version` in 200 body → `401` to client
- **Dynamic failover ladder**: Auth service returns `targets[]` array with self-contained descriptors
- **Two retry axes**:
  1. **Advance ladder** on retryable failures (429, 5xx, transport/timeout)
  2. **Re-hit same rung** per `retry_on` array (exponential backoff, default 1 retry)
- **OTAC**: One-time auth code header links auth → stats calls

**Protocol**: See `docs/architecture/auth-stats-protocol.md` for wire contract.

---

## 2. Privacy Filter Sidecar (`[privacy_filter]`)

**Purpose**: PII + hash/secret redaction before upstream, restoration after response

```toml
[privacy_filter]
# No `enabled` flag — activated by filter_mode + filter_url (sidecar)
# or filter_mode = "local" (local mode)
filter_mode = "opf"          # "opf" (sidecar) or "hash-detect" (local)
filter_url = "http://localhost:8080/redact"  # required for sidecar mode
timeout_ms = 3000
fail_open = false            # FAIL-CLOSED for privacy
pii_types = ["email", "phone", "ssn", "credit_card", "ip_address", "api_key", "jwt", "aws_key", "gcp_key", "github_token", "slack_token", "generic_secret"]
```

**Implementation** (`src/utils/privacy-filter.ts`):
- **OPF mode**: Sends text to Python sidecar, receives `{redacted_text, map}` with sentinel tokens (`████████TOKEN_0████████`)
- **Hash-detect mode**: Local regex-based detection for API keys, JWTs, AWS/GCP/GitHub/Slack tokens, generic secrets
- **Sentinel-based restore**: Maps sentinels → original values after upstream response
- **Fail-CLOSED**: `fail_open = false` blocks request on redaction failure

**Used by transforms**: `redact_pii` / `restore_pii` builtin ops

---

## 3. Image Encode Sidecar (`[fetch]`)

**Purpose**: Fetch HTTP(S) image URLs → base64 `data:` URIs for OpenAI `image_url` → Gemini `inline_data` conversion

```toml
[fetch]
# No `enabled` flag — activated by presence of `image_encode` URL
image_encode = "http://localhost:8082/fetch"  # Optional; in-process fallback if omitted
timeout_ms = 10000
max_bytes = 20971520                  # 20 MB cap
allow_private_ips = false             # SSRF guard
```

**Implementation** (`src/utils/image-fetch.ts`):
- **In-process fallback**: Works without sidecar if `url` omitted
- **SSRF protection**: Blocks private IPs (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x) unless `allow_private_ips = true`
- **20 MB limit**: Configurable cap
- **Used by transform**: `ensure_inline_images` builtin (for Gemini `generateContent` mode)

---

## 4. Tool Judge Sidecar (`[tool_judge_sidecar]`)

**Purpose**: Dynamic tool relevance filtering — prune irrelevant tools per request

```toml
[tool_judge_sidecar]
# No `enabled` flag — activated by presence of `judge_url`
judge_url = "http://localhost:8083"
timeout_ms = 5000
mode = "choice"              # "choice" | "noul"
batch_size = 64              # Max tools per call
fail_open = true             # FAIL-OPEN: pass all tools on error
```

**Implementation** (`src/utils/tool-judge-sidecar.ts`):
- **Modes**:
  - `choice`: Sidecar returns selected tool names array
  - `noul`: Sidecar returns `{name, reason}` objects with relevance scores
- **Fail-OPEN**: Errors log + return all tools unfiltered
- **Batch limiting**: Splits large tool sets into `batch_size` chunks
- **Used by**: `filter_tools` builtin transform

---

## 5. Kompress Sidecar (env: `KOMPRESS_URL`)

**Purpose**: Context compression (lossy, one-directional, English-only model)

> **Note**: Kompress is configured via **environment variables only** (not TOML).

```bash
KOMPRESS_URL=http://localhost:8084/kompress
KOMPRESS_TIMEOUT_MS=10000
KOMPRESS_KEEP_RATIO=0.3
KOMPRESS_MIN_CHARS=1000
KOMPRESS_FAIL_OPEN=true
KOMPRESS_MAX_LENGTH=20
```

| Env Var | Default | Description |
|---------|---------|-------------|
| `KOMPRESS_URL` | *(required)* | Sidecar URL — **presence enables the feature** |
| `KOMPRESS_TIMEOUT_MS` | 40000 | Per-call timeout |
| `KOMPRESS_KEEP_RATIO` | 0.5 | Target compression ratio |
| `KOMPRESS_MIN_CHARS` | 1000 | Min chars to trigger |
| `KOMPRESS_FAIL_OPEN` | true | Fail-open (return original on error) |
| `KOMPRESS_MAX_LENGTH` | 20 | Max fragments per request |
| `KOMPRESS_ENDPOINTS` | /v1/messages,/v1/chat/completions,/v1/responses | Endpoints to compress |

**Implementation** (`src/utils/kompress.ts`):
- **CJK detection**: Skips compression for Chinese/Japanese/Korean text
- **Per-fragment compression**: Splits large contexts, compresses each
- **Fail-OPEN**: Returns original text on error
- **One-directional**: Compresses request only, no decompression of response
- **English-only**: Model optimized for English

---

## 6. Coordinator Models (`[models.coordinator]`)

**Purpose**: Planner/Executor handoff — detect trigger tools to switch from planning → execution model

```toml
[models.coordinator]
planner = "anthropic/claude-3.5-sonnet"
executor = "anthropic/claude-3.5-haiku"
trigger_tools = ["ExitPlanMode", "Edit", "Write", "Bash", "NotebookEdit"]
```

**Implementation** (`src/utils/coordinator.ts`):
- **Stage detection**: Scans assistant messages for `tool_calls` matching `trigger_tools`
- **Handoff**: Once trigger detected, all subsequent turns use `executor` model
- **Source**: Pattern from `oh-my-pi` (trigger tools = code execution tools)

---

## 7. Fusion Models (`[models.fusion]`)

**Purpose**: Multi-model orchestration — panel → judge → synthesis

```toml
[models.fusion]
panel = ["model-a", "model-b", "model-c"]   # Parallel candidates
judge = "model-judge"                       # Selects best
synth = "model-synth"                       # Synthesizes final answer
```

---

## 8. Composite Models (`type = "composite"`)

**Purpose**: Weighted distribution + fallback chain

```toml
[models.my_composite]
type = "composite"
targets = [
  { model = "primary", weight = 70 },
  { model = "fallback1", weight = 20 },
  { model = "fallback2", weight = 10 }
]
fallback_chain = ["fallback1", "fallback2"]
```

---

## 9. Schedule Models (`type = "schedule"`)

**Purpose**: Time-based routing via cron expressions

```toml
[models.my_schedule]
type = "schedule"
entries = [
  { model = "day-model", cron = "0 9 * * 1-5" },   # Weekdays 9am
  { model = "night-model", cron = "0 22 * * *" }   # Daily 10pm
]
```

---

## 10. Transforms Pipeline (`[transforms.*]`)

**Purpose**: Hook-based request/response rewriting at 5 lifecycle points

### Hooks (in order):

| Hook | When | Use Cases |
|------|------|-----------|
| `request_ingress` | Raw inbound (pre-body-parse) | Auth headers, routing hints |
| `before_conversion` | After parse, before provider conversion | Redact PII, block tools, inject system prompt |
| `before_upstream` | After conversion, before upstream send | Ensure inline images, format for provider |
| `after_upstream` | After upstream response, before convert back | Strip provider metadata, normalize |
| `response_egress` | Final outbound (post-conversion) | Restore PII, add headers, logging |

### Built-in ops:
```toml
[transforms.my_set]
request_ingress = []
before_conversion = [
  { op = "filter_tools", config = { mode = "choice" } },     # Tool judge
  { op = "redact_pii" },                                       # Privacy filter
  { op = "inject_system_prompt", config = { prompt = "..." } },
]
before_upstream = [
  { op = "ensure_inline_images" },                             # Image fetch
]
after_upstream = [
  { op = "restore_pii" },                                      # Privacy restore
]
response_egress = []
```

### Custom ops (TypeScript):
```toml
[transforms.custom_op]
before_conversion = [
  { op = "custom", config = { 
    module = "./my-ops.ts", 
    export = "myOp",
    config = { ... }
  }}
]
```

---

## Key Design Patterns

| Pattern | Sidecars Using It |
|---------|-------------------|
| **Fail-CLOSED** (block on error) | Remote Auth, Privacy Filter |
| **Fail-OPEN** (degrade gracefully) | Tool Judge, Kompress, Image Fetch (fallback) |
| **Sentinel-based redaction/restore** | Privacy Filter |
| **In-process fallback** | Image Fetch |
| **SSRF protection** | Image Fetch |
| **CJK-aware processing** | Kompress |
| **Per-request dynamic config** | Remote Auth (targets[] ladder) |
| **Hook-based pipeline** | Transforms |

---

## Adding a Sidecar to Your Config

1. Copy the relevant section from `proxy_config.example.toml` into your `proxy_config.toml`
2. Set `enabled = true` and configure `url` (if sidecar-hosted) or use in-process fallback
3. Adjust `timeout_ms`, `fail_open`, and sidecar-specific options
4. For transforms: reference the transform set in your model/layer config via `transforms = "my_set"`

---

## Related Files

- **Example config**: `docs/getting-started/proxy_config.example.toml` (lines 1–640)
- **Config loader**: `src/utils/config-loader.ts` (lines 24–152, interfaces)
- **Auth/Stats protocol**: `docs/architecture/auth-stats-protocol.md`
- **Implementations**: `src/utils/privacy-filter.ts`, `image-fetch.ts`, `tool-judge-sidecar.ts`, `kompress.ts`, `coordinator.ts`