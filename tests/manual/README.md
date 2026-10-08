# Manual Tests

This directory contains manual end-to-end test scripts and configurations for the proxy v3 decision API.

## Test Scripts

### `test_proxy_decision.sh` — Real laya-mlx upstream (Recommended)

Tests the proxy v3 `/decision` endpoint against a **real laya-mlx** server.

**Prerequisites:**
```bash
# Terminal 1: Start laya-mlx serve_judge.py
uv run serve_judge.py --model aac6fef/laya-multilingual-mlx --port 8081

# Terminal 2: Start proxy v3 with laya config
PROXY_CONFIG_PATH=proxy_laya_real.toml LOG_LEVEL=debug PORT=8777 DEV_NO_KEY=true node --import tsx src/server.ts
```

**Run:**
```bash
./test_proxy_decision.sh
```

Tests 9 scenarios (14 assertions): noul, choice, score questions, image rejection, `/v1/decision` alias, validation errors.

---

### `verify_decision_e2e.sh` — Stub Clef upstream (Legacy)

Tests the proxy v3 `/decision` endpoint against a **stub Clef server** (TypeScript). Starts its own stub and 4 proxy configs automatically.

**Run:**
```bash
./verify_decision_e2e.sh
```

Tests 8 scenarios across different backend configs (stub, cloudflare, laya, none).

---

## Configuration Files

| File | Backend | Used By |
|------|---------|---------|
| `proxy_laya_real.toml` | Real laya-mlx (port 8081) | `test_proxy_decision.sh` |
| `proxy_decision_config.toml` | Stub Clef (port 8080) | `verify_decision_e2e.sh` |
| `proxy_cf.toml` | Cloudflare/Clef | `verify_decision_e2e.sh` |
| `proxy_laya.toml` | Stub laya | `verify_decision_e2e.sh` |
| `proxy_none.toml` | No backend | `verify_decision_e2e.sh` |

## Stub Server

- `stub_clef_upstream.ts` — Minimal Clef-compatible server for testing without real MLX inference.

## Log Files

`*.log` files are run artifacts from previous test executions.

## Which to Use?

- **Use `test_proxy_decision.sh`** for validating against real laya-mlx inference (current recommended path).
- **Use `verify_decision_e2e.sh`** for CI-style matrix testing against a deterministic stub.

## Different Purposes Comparison

| Aspect | `test_proxy_decision.sh` | `verify_decision_e2e.sh` |
|--------|---------------------------|---------------------------|
| **Upstream** | Real laya-mlx (MLX inference) | Stub Clef server (TypeScript) |
| **Starts services** | No (expects them running) | Yes (starts stub + 4 proxies) |
| **Backend tested** | `laya` only | `stub`, `cloudflare`, `laya`, `none` |
| **Test count** | 9 scenarios, 14 assertions | 8 scenarios |
| **Speed** | Slower (real inference) | Faster (deterministic stub) |
| **Use case** | Real E2E validation, perf | CI, regression, matrix testing |
| **Dependencies** | laya-mlx, model weights | Node.js only |