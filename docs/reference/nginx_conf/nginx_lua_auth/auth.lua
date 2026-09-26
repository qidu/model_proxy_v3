--[[
auth.lua — nginx (OpenResty) auth gate for model_proxy_v3.

Validates a single global key list against the inbound request's auth headers
(Authorization: Bearer, x-api-key, x-goog-api-key). Keys are loaded from a
separate JSON file (auth_keys.json) into ngx.shared.DICT 'proxy_auth_keys'
and refreshed when the file's mtime changes.

Wiring (put inside the relevant server { } block):

    lua_shared_dict proxy_auth_keys 1m;
    access_by_lua_block { require("auth").auth() }

Exempt paths are listed below in EXEMPT_PREFIXES. Everything else requires
a valid key.

Admins can force a reload without HUP by hitting the configured reload
location (see USAGE.md) — that location calls M.reload().
]]

local M = {}

-- Paths that bypass auth entirely. Keep this list explicit and small.
-- /health and / are the proxy's liveness endpoints; /dashboard is the
-- read-only UI (its admin actions are gated by the proxy itself via the
-- api_key in [general]). /v1/models is intentionally public so SDK
-- discovery/listing works with no credential.
local EXEMPT_PREFIXES = {
    "/health",
    "/dashboard",
    "/v1/models",
}

-- Endpoints that ALWAYS require auth. Listed for clarity / future per-path
-- tightening; the default behavior is "require auth unless exempt", so this
-- table is informational unless you switch the policy below.
local PROTECTED_PREFIXES = {
    "/v1/messages",
    "/v1/responses",
    "/v1/chat/completions",
    "/v1/embeddings",
    "/v1/models",
    "/v1beta/models/",
    "/v1/models/",
}

-- Per-path expected auth header. Matches the canonical convention each
-- upstream SDK uses on that endpoint:
--   Anthropic Messages (/v1/messages, /v1/messages/count_tokens)
--       -> x-api-key  (Authorization: Bearer accepted as fallback)
--   OpenAI (/v1/responses, /v1/chat/completions, /v1/embeddings)
--       -> Authorization: Bearer
--   Gemini native (/v1beta/models/*:generateContent, :countTokens)
--       -> x-goog-api-key
-- /v1/models is intentionally absent: it's listed in every SDK's docs and
-- we accept any of the three headers there (see path_expected_header()).
local HEADER_BY_PREFIX = {
    ["/v1/messages"]            = "x-api-key",
    ["/v1/responses"]           = "authorization",
    ["/v1/chat/completions"]    = "authorization",
    ["/v1/embeddings"]          = "authorization",
    ["/v1beta/models/"]         = "x-goog-api-key",
}

-- Endpoints that accept a fallback header when the primary is absent.
-- Anthropic's own clients send x-api-key, but many generic Bearer-token
-- clients hit /v1/messages; the Worker itself accepts Bearer there.
local FALLBACK_BY_PREFIX = {
    ["/v1/messages"] = "authorization", -- Bearer fallback for x-api-key
}

-- Policy: "require" (default) means auth is required unless the path is in
-- EXEMPT_PREFIXES. Switch to "protected_only" to require auth only on paths
-- under PROTECTED_PREFIXES and leave everything else open.
local POLICY = "require"

local KEYS_FILE = ngx.config.prefix() .. "conf/auth_keys.json"

-- Read the JSON keys file with cjson-safe parsing. Returns a set table
-- { [key] = true } or nil + errmsg.
local function load_keys()
    local file, err = io.open(KEYS_FILE, "r")
    if not file then
        return nil, "cannot open " .. KEYS_FILE .. ": " .. (err or "?")
    end
    local body = file:read("*a")
    file:close()

    local ok, data = pcall(require("cjson.safe").decode, body)
    if not ok or type(data) ~= "table" then
        return nil, "invalid JSON in " .. KEYS_FILE
    end
    local list = data.keys
    if type(list) ~= "table" then
        return nil, KEYS_FILE .. ": missing 'keys' array"
    end

    local set, n = {}, 0
    for _, k in ipairs(list) do
        if type(k) == "string" and #k > 0 then
            set[k] = true
            n = n + 1
        end
    end
    if n == 0 then
        return nil, KEYS_FILE .. ": 'keys' array is empty"
    end
    return set, nil
end

-- Refresh the shared dict if the file mtime advanced (or dict is empty).
local function refresh_if_stale(dict)
    local file_mtime = (function()
        local f, err = io.open(KEYS_FILE, "r")
        if not f then return nil, err end
        local m = f:seek("end") -- not real mtime; we use lfs below if available
        f:close()
        return m
    end)()

    -- Prefer real mtime via lfs; fall back to file size if lfs is unavailable.
    local mtime
    local lfs_ok, lfs = pcall(require, "lfs")
    if lfs_ok then
        local attr_ok, st = pcall(lfs.attributes, KEYS_FILE)
        if attr_ok and type(st) == "table" then
            mtime = st.modification
        end
    end
    mtime = mtime or file_mtime

    local cached_mtime = dict:get("__mtime")
    local cached_count = tonumber(dict:get("__count") or "0") or 0

    if cached_count > 0 and mtime and cached_mtime == tostring(mtime) then
        return true -- fresh
    end

    local set, err = load_keys()
    if not set then
        -- Fail loud: keep whatever is cached (if any) and surface the error.
        if cached_count > 0 then
            ngx.log(ngx.ERR, "auth.lua: using stale keys (reload failed: ", err, ")")
            return true
        end
        return nil, err
    end

    dict:flush_all()
    local n = 0
    for k in pairs(set) do
        -- Store the raw key so lookups are O(1) hash probes; never iterate
        -- back to the client.
        dict:set("k:" .. k, "1")
        n = n + 1
    end
    dict:set("__count", tostring(n))
    dict:set("__mtime", mtime and tostring(mtime) or "0")
    ngx.log(ngx.WARN, "auth.lua: loaded ", n, " keys from ", KEYS_FILE)
    return true
end

function M.reload()
    local dict = ngx.shared.proxy_auth_keys
    if not dict then
        return nil, "shared dict 'proxy_auth_keys' not declared"
    end
    local ok, err = refresh_if_stale(dict)
    return ok, err
end

-- Map a request path to its expected auth header (lowercased nginx var
-- suffix, e.g. "x-api-key", "authorization", "x-goog-api-key"). Returns
-- nil for endpoints with no fixed convention (e.g. /v1/models) — those
-- accept any of the three.
local function path_expected_header(path)
    for prefix, h in pairs(HEADER_BY_PREFIX) do
        if path:sub(1, #prefix) == prefix then
            return h, FALLBACK_BY_PREFIX[prefix]
        end
    end
    return nil, nil
end

-- Read a credential value from a logical header name. "authorization"
-- returns the bearer token (or nil if absent / not Bearer); the others
-- return the raw header value.
local function read_header(name)
    if name == "authorization" then
        local auth = ngx.var.http_authorization
        if not auth then return nil end
        local _, _, token = auth:find("^%s*[Bb]earer%s+(%S+)%s*$")
        return token
    elseif name == "x-api-key" then
        return ngx.var.http_x_api_key
    elseif name == "x-goog-api-key" then
        return ngx.var.http_x_goog_api_key
    end
    return nil
end

-- Extract the presented credential. If the path mandates a specific header,
-- only that header (and its declared fallback) is consulted; otherwise all
-- three are tried. Returns (key, header_name_used) or (nil, nil).
local function presented_key(path)
    local primary, fallback = path_expected_header(path)
    if primary then
        local v = read_header(primary)
        if v and #v > 0 then return v, primary end
        if fallback then
            local fv = read_header(fallback)
            if fv and #fv > 0 then return fv, fallback end
        end
        return nil, nil
    end
    -- No path-specific rule: accept any of the three.
    for _, h in ipairs({ "authorization", "x-api-key", "x-goog-api-key" }) do
        local v = read_header(h)
        if v and #v > 0 then return v, h end
    end
    return nil, nil
end

local function is_exempt(path)
    for _, p in ipairs(EXEMPT_PREFIXES) do
        if path == p or path:sub(1, #p + 1) == p .. "/" then return true end
        if path:sub(1, #p) == p then return true end
    end
    return false
end

local function path_requires_auth(path)
    if POLICY == "protected_only" then
        for _, p in ipairs(PROTECTED_PREFIXES) do
            if path:sub(1, #p) == p then return true end
        end
        return false
    end
    return not is_exempt(path)
end

local function deny(code, msg)
    ngx.status = code
    ngx.header["Content-Type"] = "application/json"
    -- Envelope mirrors the proxy's own createErrorResponse shape.
    ngx.say('{"type":"error","error":{"type":"authentication_error","message":'
             .. require("cjson.safe").encode(msg) .. '}}')
    ngx.exit(ngx.HTTP_OK) -- we already set status; exit cleanly
end

function M.auth()
    local dict = ngx.shared.proxy_auth_keys
    if not dict then
        ngx.log(ngx.EMERG, "auth.lua: lua_shared_dict proxy_auth_keys missing")
        return deny(500, "auth module misconfigured")
    end

    local path = ngx.var.uri or ""

    if not path_requires_auth(path) then
        return
    end

    -- Ensure keys are loaded (best-effort; fail loud if first load fails).
    if not M.reload() then
        return deny(503, "auth keys unavailable")
    end

    local primary = path_expected_header(path)
    local key, used = presented_key(path)
    if not key then
        ngx.log(ngx.INFO, "auth.lua: no credential on ", path)
        local want = primary
            and ("expected header: " .. primary)
            or  "expected any of: Authorization, x-api-key, x-goog-api-key"
        return deny(401, "missing API key (" .. want .. ")")
    end

    -- O(1) probe; the dict is shared across workers so there is no per-worker
    -- key list to leak via timing beyond the dict's own hash cost.
    if not dict:get("k:" .. key) then
        ngx.log(ngx.WARN, "auth.lua: invalid key on ", path, " via ", used)
        return deny(401, "invalid API key")
    end

    -- Success: fall through to the proxy_pass chain.
end

return M
