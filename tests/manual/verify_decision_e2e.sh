#!/usr/bin/env bash
# Manual end-to-end verification of POST /decision through the running proxy
# (src/index.ts route wiring -> auth gate -> handler -> upstream), with a stub
# Clef upstream standing in for the real Laya sidecar (MLX is Apple-Silicon
# only and cannot run on this machine).
#
# Exercises what tests/unit/decision.test.ts cannot: the handler is called
# directly in the unit tests, so route matching, body consumption and the
# deferred auth gate in src/index.ts are untested there.
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1
ROOT="$PWD"
STUB_PORT=19999
STUB_URL="http://127.0.0.1:$STUB_PORT"
# Use 18788-18791 for test proxies to avoid colliding with user's dev proxy on 8788
LAYA_PORT=18788
CF_PORT=18789
NONE_PORT=18790
KEY_PORT=18791
PIDS=()

# Helpers to read recorded stub traffic over HTTP (avoids /tmp path mismatch
# between Windows Node and git-bash).
stub_count()   { curl -s "$STUB_URL/__count"; }
stub_requests() { curl -s "$STUB_URL/__requests"; }
# node-bool: evaluates a JS expression with variable `d` (parsed JSON from stdin)
# and prints "yes" or "no". E.g.: echo '{"a":1}' | nodeq 'd.a === 1'
nodeq() { node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    let d; try{d=JSON.parse(s)}catch{ console.log("no"); return }
    let r; try { r = (function(d){ return ('"$1"'); })(d) } catch { console.log("no"); return }
    console.log(r ? "yes" : "no");
  });
'; }
# node-value: like nodeq but prints the expression's value verbatim (empty on
# error), for checks that assert an exact value rather than a yes/no predicate.
nodev() { node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    let d; try{d=JSON.parse(s)}catch{ return }
    let r; try { r = (function(d){ return ('"$1"'); })(d) } catch { return }
    console.log(r === undefined || r === null ? "" : String(r));
  });
'; }

cleanup() {
  echo ""
  echo "--- cleanup ---"
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "killing pid $pid"
      kill "$pid" 2>/dev/null
    fi
  done
  sleep 1
  for pid in "${PIDS[@]}"; do
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
  done
  # Safety net: kill any listeners left on our own test ports. These are high
  # ports reserved for this script; they must never include the user's dev proxy
  # port (8788).
  for p in 18788 18789 18790 18791 19999; do
    for pid in $(port_pids "$p"); do
      taskkill //PID "$pid" //F 2>/dev/null && echo "  force-killed leftover on :$p (pid $pid)"
    done
  done
  rm -f "$ROOT/tests/manual/proxy_decision_none.toml" \
        "$ROOT/tests/manual/proxy_decision_cf.toml" \
        "$ROOT/tests/manual/proxy_decision_key.toml"
}
trap cleanup EXIT

# PIDs listening on a TCP port. Windows netstat puts the address BEFORE the
# state, so the match must be ":$port " (local address column) then LISTENING.
port_pids() {  # $1=port
  netstat -ano 2>/dev/null | grep -E "[.:]$1[[:space:]]+.*LISTENING" | awk '{print $NF}' | sort -u
}

require_ports_free() {
  local busy=0
  for p in 18788 18789 18790 18791 19999; do
    local pids
    pids=$(port_pids "$p")
    if [ -n "$pids" ]; then
      echo "FATAL: port $p already in use by pid(s): $pids"
      busy=1
    fi
  done
  if [ "$busy" = "1" ]; then
    echo "Kill the leftovers above, then re-run. Refusing to run against a proxy this script did not start."
    exit 1
  fi
}

start_proxy() {  # $1=port  $2=config path  $3=label
  # Use node --import tsx directly (single process, no npx shim PID leak)
  PORT="$1" PROXY_CONFIG_PATH="$2" LOG_LEVEL=warn DEV_NO_KEY=true \
    node --import tsx "$ROOT/src/server.ts" > "$ROOT/tests/manual/proxy_$3.log" 2>&1 &
  echo $!
}

wait_for_port() {  # $1=port
  for _ in $(seq 1 60); do
    if curl -s -o /dev/null "http://127.0.0.1:$1/health" 2>/dev/null; then return 0; fi
    sleep 0.5
  done
  return 1
}

PASS=0; FAIL=0
check() {  # $1=label  $2=expected  $3=actual
  if [ "$2" = "$3" ]; then
    echo "  PASS  $1 (expected $2, got $3)"; PASS=$((PASS+1))
  else
    echo "  FAIL  $1 (expected $2, got $3)"; FAIL=$((FAIL+1))
  fi
}

# ---------------------------------------------------------------- stub upstream
require_ports_free
STUB_PID=$(STUB_PORT=$STUB_PORT node --import tsx "$ROOT/tests/manual/stub_clef_upstream.ts" > "$ROOT/tests/manual/stub.log" 2>&1 & echo $!)
PIDS+=("$STUB_PID")
echo "stub upstream pid=$STUB_PID"
wait_for_port "$STUB_PORT" || { echo "FATAL: stub did not start"; cat "$ROOT/tests/manual/stub.log"; exit 1; }
echo "stub upstream ready"

# --------------------------------------------------------- config: no [decision]
cat > "$ROOT/tests/manual/proxy_decision_none.toml" <<'EOF'
[general]
EOF

# ------------------------------------------------------------------ two proxies
LAYA_PID=$(start_proxy "$LAYA_PORT" "$ROOT/tests/manual/proxy_decision_config.toml" laya)
PIDS+=("$LAYA_PID")
echo "proxy(laya) pid=$LAYA_PID"
wait_for_port "$LAYA_PORT" || { echo "FATAL: laya proxy did not start"; tail -30 "$ROOT/tests/manual/proxy_laya.log"; exit 1; }
echo "proxy(laya) ready"

sed 's/backend = "laya"/backend = "cloudflare"/' \
  "$ROOT/tests/manual/proxy_decision_config.toml" > "$ROOT/tests/manual/proxy_decision_cf.toml"
CF_PID=$(start_proxy "$CF_PORT" "$ROOT/tests/manual/proxy_decision_cf.toml" cf)
PIDS+=("$CF_PID")
echo "proxy(cloudflare) pid=$CF_PID"
wait_for_port "$CF_PORT" || { echo "FATAL: cloudflare proxy did not start"; tail -30 "$ROOT/tests/manual/proxy_cf.log"; exit 1; }
echo "proxy(cloudflare) ready"

NONE_PID=$(start_proxy "$NONE_PORT" "$ROOT/tests/manual/proxy_decision_none.toml" none)
PIDS+=("$NONE_PID")
echo "proxy(unconfigured) pid=$NONE_PID"
wait_for_port "$NONE_PORT" || { echo "FATAL: unconfigured proxy did not start"; tail -30 "$ROOT/tests/manual/proxy_none.log"; exit 1; }
echo "proxy(unconfigured) ready"

L="http://127.0.0.1:$LAYA_PORT/decision"
C="http://127.0.0.1:$CF_PORT/decision"
N="http://127.0.0.1:$NONE_PORT/decision"
H='Content-Type: application/json'

echo ""
echo "=========================== 1. noul / choice / score ==========================="
NOUL='{"model":"clef","state":"a chat log","questions":{"keep":{"type":"noul","instructions":"Is this safe to edit?"}}}'
r=$(curl -s -w '\n%{http_code}' -X POST "$L" -H "$H" -d "$NOUL")
code=$(echo "$r" | tail -1); body=$(echo "$r" | sed '$d')
check "noul -> 200" 200 "$code"
echo "        body: $body"
check "noul answer is a number in [0,1]" "yes" "$(echo "$body" | nodeq "typeof d.answers.keep.noul === 'number' && d.answers.keep.noul >= 0 && d.answers.keep.noul <= 1")"
check "envelope has model/answers/usage" "yes" "$(echo "$body" | nodeq "'model' in d && 'answers' in d && 'usage' in d")"

CHOICE='{"model":"clef","state":"x","questions":{"plan":{"type":"choice","instructions":"Pick","criteria":["free","pro"]}}}'
r=$(curl -s -w '\n%{http_code}' -X POST "$L" -H "$H" -d "$CHOICE")
code=$(echo "$r" | tail -1); body=$(echo "$r" | sed '$d')
check "choice -> 200" 200 "$code"
echo "        body: $body"
check "choice has probabilities summing to 1" "yes" "$(echo "$body" | nodeq "Object.values(d.answers.plan.probabilities).reduce((a,b)=>a+b,0) > 0.999999")"

SCORE='{"model":"clef","state":"x","questions":{"risk":{"type":"score","instructions":"Rate","legend":{"0":"none","1":"high"}}}}'
r=$(curl -s -w '\n%{http_code}' -X POST "$L" -H "$H" -d "$SCORE")
code=$(echo "$r" | tail -1); body=$(echo "$r" | sed '$d')
check "score -> 200" 200 "$code"
echo "        body: $body"

echo ""
echo "=========================== 2. images gate (laya) ==========================="
BEFORE=$(stub_count)
IMG='{"model":"clef","state":"x","questions":{"q":{"type":"noul","instructions":"y"}},"images":[{"url":"http://example.com/a.png"}]}'
r=$(curl -s -w '\n%{http_code}' -X POST "$L" -H "$H" -d "$IMG")
code=$(echo "$r" | tail -1); body=$(echo "$r" | sed '$d')
check "images on laya -> 400" 400 "$code"
echo "        body: $body"
AFTER=$(stub_count)
check "laya rejected BEFORE any upstream call" "$BEFORE" "$AFTER"

echo ""
echo "===================== 3. images forwarded (cloudflare) ====================="
BEFORE=$(stub_count)
r=$(curl -s -w '\n%{http_code}' -X POST "$C" -H "$H" -d "$IMG")
code=$(echo "$r" | tail -1); body=$(echo "$r" | sed '$d')
check "images on cloudflare -> 200" 200 "$code"
AFTER=$(stub_count)
check "cloudflare DID call upstream" "$((BEFORE+1))" "$AFTER"
check "images reached the upstream intact" 1 \
  "$(stub_requests | nodev 'd[d.length-1].body.images.length')"

echo ""
echo "========================= 4. envelope validation =========================="
r=$(curl -s -w '\n%{http_code}' -X POST "$L" -H "$H" -d '{"state":"x","questions":{"q":{"type":"noul"}}}')
check "missing model -> 400" 400 "$(echo "$r" | tail -1)"
r=$(curl -s -w '\n%{http_code}' -X POST "$L" -H "$H" -d 'not json')
check "malformed JSON -> 400" 400 "$(echo "$r" | tail -1)"
r=$(curl -s -w '\n%{http_code}' -X POST "$L" -H "$H" -d '{"model":"clef","state":"x","questions":{}}')
check "empty questions -> 400" 400 "$(echo "$r" | tail -1)"

echo ""
echo "==================== 5. unconfigured [decision] -> 503 ===================="
r=$(curl -s -w '\n%{http_code}' -X POST "$N" -H "$H" -d "$NOUL")
check "no [decision] section -> 503" 503 "$(echo "$r" | tail -1)"
echo "        body: $(echo "$r" | sed '$d')"

echo ""
echo "=========================== 6. auth + verbatim ============================"
export WANT="$NOUL"
check "request body reached upstream unchanged" "yes" \
  "$(stub_requests | nodeq 'd.some(r => JSON.stringify(r.body) === JSON.stringify(JSON.parse(process.env.WANT)))')"
unset WANT

echo ""
echo "===================== 7. api_key -> Authorization header =================="
sed 's|# api_key = ""  # not set for this test|api_key = "sk-test-key-123"|' \
  "$ROOT/tests/manual/proxy_decision_config.toml" > "$ROOT/tests/manual/proxy_decision_key.toml"
KEY_PID=$(start_proxy "$KEY_PORT" "$ROOT/tests/manual/proxy_decision_key.toml" key)
PIDS+=("$KEY_PID")
if wait_for_port "$KEY_PORT"; then
  curl -s -o /dev/null -X POST "http://127.0.0.1:$KEY_PORT/decision" -H "$H" -d "$NOUL"
  check "api_key sent as Bearer" "Bearer sk-test-key-123" \
    "$(stub_requests | nodev 'd[d.length-1].headers.authorization')"
else
  echo "  FAIL  proxy(key) did not start"; FAIL=$((FAIL+1))
fi

echo ""
echo "===================== 8. /v1/decision is the same route ====================="
r=$(curl -s -w '\n%{http_code}' -X POST "http://127.0.0.1:$LAYA_PORT/v1/decision" -H "$H" -d "$NOUL")
code=$(echo "$r" | tail -1); body=$(echo "$r" | sed '$d')
check "/v1/decision -> 200" 200 "$code"
check "/v1/decision returns the Clef envelope" "yes" \
  "$(echo "$body" | nodeq "'model' in d && 'answers' in d && 'usage' in d")"
# The images gate must fire on the alias too. That is what distinguishes "the
# same handler, reached by a second path" from "the path fell through to some
# other route that happened to answer 200".
BEFORE=$(stub_count)
r=$(curl -s -w '\n%{http_code}' -X POST "http://127.0.0.1:$LAYA_PORT/v1/decision" -H "$H" -d "$IMG")
check "/v1/decision applies the laya images gate -> 400" 400 "$(echo "$r" | tail -1)"
check "/v1/decision rejected BEFORE any upstream call" "$BEFORE" "$(stub_count)"

echo ""
echo "============================= stub traffic ============================="
stub_requests | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    let arr; try{arr=JSON.parse(s)}catch{ process.exit(0) }
    for (let i=0; i<arr.length; i++) {
      const d=arr[i];
      const qs=Object.keys(d.body.questions).join(",");
      const img=Array.isArray(d.body.images)?d.body.images.length:0;
      const auth=d.headers.authorization?"yes":"no";
      console.log(`  ${i+1}. model=${d.body.model} qs=${qs} images=${img} auth=${auth}`);
    }
  });
'

echo ""
echo "================================ RESULT ================================"
echo "  PASS: $PASS   FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
