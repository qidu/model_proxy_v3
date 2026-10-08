# nginx + Lua auth gate for model_proxy_v3

Standalone auth side: a single OpenResty `server` block enforces a global key
list before requests reach the Worker. Keys live in `auth_keys.json` and are
loaded into a shared dict; the script auto-refreshes when the file mtime
changes.

## Files

| file              | purpose                                                        |
|-------------------|----------------------------------------------------------------|
| `auth.lua`        | the auth module; `require("auth").auth()` runs per request     |
| `auth_keys.json`  | the key list — edit this, then reload (see below)              |
| `USAGE.md`        | this file                                                      |

## Install

1. Copy `auth.lua` and `auth_keys.json` to nginx' conf dir, e.g. `/etc/openresty/conf/`.
2. In the relevant `http { }` block, declare the shared dict:

   ```nginx
   lua_shared_dict proxy_auth_keys 1m;
   lua_package_path "/etc/openresty/conf/?.lua;;";
   ```

3. In the `server { }` block that fronts the proxy, add the access phase:

   ```nginx
   server {
       listen 443 ssl;
       server_name proxy.example.com;

       access_by_lua_block { require("auth").auth() }

       # everything below is your existing config:
       location / {
           proxy_pass http://127.0.0.1:8787;  # the worker
       }

       # Optional: admin-only reload trigger. Auth runs BEFORE this block,
       # so guard it with a separate admin key (e.g. via allow/deny, mTLS,
       # or an internal-only listen port). Do NOT expose publicly.
       location = /_auth_reload {
           internal;
           content_by_lua_block {
               local ok, err = require("auth").reload()
               if not ok then
                   ngx.status = 500
                   ngx.say("reload failed: ", err)
                   return
               end
               ngx.say("reloaded")
           }
       }
   }
   ```

## What it enforces

- Reads `Authorization: Bearer <key>`, `x-api-key`, or `x-goog-api-key`
  (same headers the Worker forwards to its `auth_server` sidecar).
- A path requires auth unless it is in `EXEMPT_PREFIXES` in `auth.lua`
  (`/health`, `/dashboard`). Everything else — `/v1/messages`,
  `/v1/responses`, `/v1/chat/completions`, `/v1/embeddings`, `/v1/models`,
  `/v1beta/models/*`, etc. — requires a key.
- On miss/invalid: returns 401 with a JSON envelope shaped like the proxy's
  own error response (`{"type":"error","error":{...}}`).

## Reloading keys

Edit `auth_keys.json`, then either:

- `nginx -s reload` (the next request repopulates the shared dict), or
- `curl http://127.0.0.127/_auth_reload` from a trusted host.

No restart needed. The loader detects mtime changes and rebuilds the set;
if a reload fails, it keeps the previously cached set and logs an error
(fail-loud, never an empty key list in memory).

## Tuning knobs (top of `auth.lua`)

- `EXEMPT_PREFIXES` — paths that bypass auth.
- `PROTECTED_PREFIXES` — informational; switch `POLICY` to
  `"protected_only"` to require auth only on these and leave everything
  else open.
- `POLICY` — `"require"` (default) or `"protected_only"`.

## Notes / decisions

- Constant-time-ish lookup: keys are stored in a shared dict and probed by
  hash, not by per-character comparison. The dict is shared across workers,
  so there's no per-worker key list whose presence/absence leaks via timing.
- This gate is **complementary** to `auth_server` in `proxy_config.toml`. You
  can run both: nginx does the cheap key check, the Worker still calls your
  `auth_server` for per-model policy via `x-resource-for` if configured. If you
  only want one, set `auth_server` to empty in the config and rely on this Lua
  gate alone.
