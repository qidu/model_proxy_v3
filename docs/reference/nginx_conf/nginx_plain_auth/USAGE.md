# Plain-nginx auth gate for model_proxy_v3

Same policy as the Lua variant, but using only stock `map` + `if` + `return` —
no OpenResty, no Lua, no shared dict. Runs on any nginx build.

## What it enforces

| Path                             | Required header               | Valid-key map           |
|----------------------------------|-------------------------------|-------------------------|
| `/v1/messages`                   | `x-api-key` (Bearer fallback) | `$key_anth_valid`       |
| `/v1/responses`                  | `Authorization: Bearer`       | `$key_openai_valid`     |
| `/v1/chat/completions`           | `Authorization: Bearer`       | `$key_openai_valid`     |
| `/v1/embeddings`                 | `Authorization: Bearer`       | `$key_openai_valid`     |
| `/v1beta/models/*`               | `x-goog-api-key`              | `$key_gemini_valid`     |
| `/v1/models`, `/health`, `/`, `/dashboard` | — (exempt)          | —                       |

On miss/invalid: HTTP 401 with a JSON envelope shaped like the proxy's own
error response.

## Install

1. `include /etc/nginx/proxy_auth.conf;` inside your `http { }` block, **or**
   copy the contents of `nginx.conf` into it directly. The `map` blocks must
   be in `http{}` scope — they cannot live inside `server{}`.
2. Edit the three valid-key maps at the top of `nginx.conf`. Each maps a
   presented credential to the sentinel `"ok"`; unknown keys fall through to
   `default ""`. Add one line per accepted key:

   ```nginx
   map $cred_anth $key_anth_valid {
       default            "";
       "sk-proxy-ANTH-1"  "ok";
       "sk-proxy-ANTH-2"  "ok";
   }
   map $auth_bearer $key_openai_valid {
       default            "";
       "sk-proxy-OPEN-1"  "ok";
   }
   map $http_x_goog_api_key $key_gemini_valid {
       default            "";
       "sk-proxy-GEM-1"   "ok";
   }
   ```

3. Set `$proxy_upstream` to wherever the Worker / node server listens.
4. Fill in the TLS cert paths and `server_name`.
5. `nginx -t && nginx -s reload`.

## How the compare works (multi-key via map membership)

Each location checks a runtime variable against a fixed sentinel via `if`:

```nginx
if ($cred_anth = "")          { return 401 ...; }   # missing
if ($key_anth_valid != "ok")  { return 401 ...; }   # invalid
```

`$cred_anth` is the presented credential (x-api-key or bearer), normalized
via `map` chains at the top of the file. `$key_anth_valid` is the result of
a `map` lookup that hashes the presented credential against the configured
key set — known keys return `"ok"`, unknown keys fall through to `default ""`.

The map is hash-based, so lookup is O(1) regardless of how many keys are
configured. To add or remove a key, edit the relevant map block and
`nginx -s reload` — the table rebuilds on reload, no restart needed.

If you need a dynamic key file (JSON, hundreds of keys, runtime reload
without editing the conf), switch to the Lua variant in
`tmp/nginx_lua_auth/` — plain nginx cannot do that cleanly.

## Why the Anthropic location accepts a Bearer fallback

The Worker (`src/handlers/messages.ts:286`) reads `Authorization` *then*
`x-api-key` *then* `x-goog-api-key`, so many generic Bearer clients hit
`/v1/messages`. The conf mirrors that: the presented credential is
"x-api-key if present, else bearer token", and `$key_anth_valid` is the
result of looking that credential up in the Anthropic key set.

If you want them to differ (different key for Bearer vs x-api-key on
`/v1/messages`), split into two maps and chain them.

## Reload

`nginx -s reload` — no restart needed. The `map` tables are rebuilt on reload.

## Notes

- The `if ($var = 0) { return 401 ...; }` pattern is one of the documented
  *safe* uses of `if` inside `location` (the directive is `return`, which is
  unconditional and does not interact with `try_files` / rewriting).
- `/v1/models/` (trailing slash, a sub-resource) returns 404 — fail-closed.
  Only the bare `/v1/models` and `/v1/models?...` are exempt.
- This is **complementary** to `auth_server` in `proxy_config.toml`. You can
  run both; nginx does the cheap key check, the Worker still calls your
  `auth_server` sidecar for non-exempt paths if configured.
