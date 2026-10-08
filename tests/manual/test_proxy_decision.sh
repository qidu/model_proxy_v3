#!/usr/bin/env bash
# Test proxy v3 /decision endpoint against real laya-mlx on port 8777
# Usage: ./test_proxy_decision.sh
#
# Prerequisites:
#   1. Start laya-mlx serve_judge.py on port 8081:
#      uv run serve_judge.py --model aac6fef/laya-multilingual-mlx --port 8081
#   2. Start proxy on port 8777 with config pointing to laya-mlx:
#      PROXY_CONFIG_PATH=proxy_laya_real.toml LOG_LEVEL=debug PORT=8777 DEV_NO_KEY=true node --import tsx src/server.ts

set -uo pipefail

PORT=8777
BASE="http://127.0.0.1:$PORT"
HDR='Content-Type: application/json'

PASS=0
FAIL=0

check() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  PASS  $label (expected $expected, got $actual)"
    PASS=$((PASS+1))
  else
    echo "  FAIL  $label (expected $expected, got $actual)"
    FAIL=$((FAIL+1))
  fi
}

# Extract HTTP code from curl output (last line)
curl_code() {
  echo "$1" | tail -1
}

# Extract body from curl output (all but last line)
curl_body() {
  echo "$1" | sed '$d'
}

echo "============================================================"
echo "Testing proxy v3 /decision endpoint on port $PORT"
echo "============================================================"
echo ""

# Test 1: Valid noul question
echo "Test 1: Valid noul question"
r=$(curl -s -w '\n%{http_code}' -X POST "$BASE/decision" -H "$HDR" \
  -d '{"model":"laya-multilingual-mlx","state":"User: What is the weather?\nAssistant: I cannot know.","questions":{"q1":{"type":"noul","instructions":"Is this safe to answer?"}}}')
code=$(curl_code "$r"); body=$(curl_body "$r")
check "noul -> 200" 200 "$code"
echo "        body: $body"
# Verify Clef envelope structure
has_envelope=$(echo "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let d=JSON.parse(s);console.log("model" in d && "answers" in d && "usage" in d ? "yes" : "no")}catch{console.log("no")}})')
check "noul has Clef envelope (model/answers/usage)" "yes" "$has_envelope"

echo ""

# Test 2: Choice question
echo "Test 2: Choice question"
r=$(curl -s -w '\n%{http_code}' -X POST "$BASE/decision" -H "$HDR" \
  -d '{"model":"laya-multilingual-mlx","state":"User: test","questions":{"tool_choice":{"type":"choice","instructions":"Pick","criteria":{"keep":"Keep the tool","discard":"Discard the tool"}}}}')
code=$(curl_code "$r"); body=$(curl_body "$r")
check "choice -> 200" 200 "$code"
echo "        body: $body"
has_envelope=$(echo "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let d=JSON.parse(s);console.log("model" in d && "answers" in d && "usage" in d ? "yes" : "no")}catch{console.log("no")}})')
check "choice has Clef envelope" "yes" "$has_envelope"

echo ""

# Test 3: Score question
echo "Test 3: Score question"
r=$(curl -s -w '\n%{http_code}' -X POST "$BASE/decision" -H "$HDR" \
  -d '{"model":"laya-multilingual-mlx","state":"x","questions":{"risk":{"type":"score","instructions":"Rate risk","criteria":["none","low","medium","high"]}}}')
code=$(curl_code "$r"); body=$(curl_body "$r")
check "score -> 200" 200 "$code"
echo "        body: $body"
has_envelope=$(echo "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let d=JSON.parse(s);console.log("model" in d && "answers" in d && "usage" in d ? "yes" : "no")}catch{console.log("no")}})')
check "score has Clef envelope" "yes" "$has_envelope"

echo ""

# Test 4: Image rejection (laya backend)
echo "Test 4: Image rejection (laya backend should reject before upstream)"
r=$(curl -s -w '\n%{http_code}' -X POST "$BASE/decision" -H "$HDR" \
  -d '{"model":"laya-multilingual-mlx","state":"x","questions":{"q":{"type":"noul","instructions":"y"}},"images":[{"url":"http://example.com/a.png"}]}')
code=$(curl_code "$r"); body=$(curl_body "$r")
check "images on laya -> 400" 400 "$code"
echo "        body: $body"
# Verify error message mentions laya backend
has_laya_msg=$(echo "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let d=JSON.parse(s);console.log(d.error?.message?.includes("laya") ? "yes" : "no")}catch{console.log("no")}})')
check "error mentions laya backend" "yes" "$has_laya_msg"

echo ""

# Test 5: /v1/decision alias
echo "Test 5: /v1/decision alias route"
r=$(curl -s -w '\n%{http_code}' -X POST "$BASE/v1/decision" -H "$HDR" \
  -d '{"model":"laya-multilingual-mlx","state":"x","questions":{"q":{"type":"noul","instructions":"test"}}}')
code=$(curl_code "$r"); body=$(curl_body "$r")
check "/v1/decision -> 200" 200 "$code"
echo "        body: $body"
has_envelope=$(echo "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let d=JSON.parse(s);console.log("model" in d && "answers" in d && "usage" in d ? "yes" : "no")}catch{console.log("no")}})')
check "/v1/decision has Clef envelope" "yes" "$has_envelope"

echo ""

# Test 6: /v1/decision applies images gate
echo "Test 6: /v1/decision applies images gate"
r=$(curl -s -w '\n%{http_code}' -X POST "$BASE/v1/decision" -H "$HDR" \
  -d '{"model":"laya-multilingual-mlx","state":"x","questions":{"q":{"type":"noul","instructions":"y"}},"images":[{"url":"http://example.com/a.png"}]}')
code=$(curl_code "$r"); body=$(curl_body "$r")
check "/v1/decision images -> 400" 400 "$code"
echo "        body: $body"

echo ""

# Test 7: Missing model field
echo "Test 7: Missing model field -> 400"
r=$(curl -s -w '\n%{http_code}' -X POST "$BASE/decision" -H "$HDR" \
  -d '{"state":"x","questions":{"q":{"type":"noul"}}}')
code=$(curl_code "$r")
check "missing model -> 400" 400 "$code"

echo ""

# Test 8: Empty questions object
echo "Test 8: Empty questions object -> 400"
r=$(curl -s -w '\n%{http_code}' -X POST "$BASE/decision" -H "$HDR" \
  -d '{"model":"laya-multilingual-mlx","state":"x","questions":{}}')
code=$(curl_code "$r")
check "empty questions -> 400" 400 "$code"

echo ""

# Test 9: Malformed JSON
echo "Test 9: Malformed JSON -> 400"
r=$(curl -s -w '\n%{http_code}' -X POST "$BASE/decision" -H "$HDR" \
  -d 'not json')
code=$(curl_code "$r")
check "malformed JSON -> 400" 400 "$code"

echo ""
echo "============================================================"
echo "RESULT: PASS=$PASS  FAIL=$FAIL"
echo "============================================================"
[ "$FAIL" -eq 0 ] || exit 1