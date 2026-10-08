===============================================================================
VALIDATING THE TOOL JUDGE SIDECAR (proxy v3 + local Laya judge)
===============================================================================

Verified 2026-10-05 on macOS / Apple Silicon, branch feature/targeting_failover.

Validates three layers, in increasing order of coverage:

  Layer A  judge sidecar alone       -- the wrapper + Laya model
  Layer B  full proxy path           -- config file -> proxy -> judge (THE ONE
                                        THAT MATTERS; A and C both pass even
                                        when the proxy wiring is broken)
  Layer C  client unit path          -- judgeTools driven directly in-process

Prerequisite for Layer B: src/utils/config-loader.ts must contain the
[tool_judge_sidecar] dispatch branch. Before that fix the section was SILENTLY
DROPPED (no error, no warning) and the judge never ran. Check with:

    grep -n "tool_judge_sidecar" src/utils/config-loader.ts

You should see a dispatch branch near the [privacy_filter] one (~line 2861),
plus two value-assign branches (~2953, ~3281). If only the type declaration at
~line 138 appears, Layer B cannot work no matter what the config says.


-------------------------------------------------------------------------------
0. SETUP
-------------------------------------------------------------------------------

The judge needs Apple Silicon (MLX). Use Python 3.13 from Homebrew:

    /opt/homebrew/opt/python@3.13/bin/python3.13 -m venv /tmp/laya-venv
    /tmp/laya-venv/bin/pip install mlx numpy huggingface-hub tokenizers

You never need to activate the venv -- every command below uses the absolute
interpreter path /tmp/laya-venv/bin/python, which avoids the usual mistake of
running the activate script instead of sourcing it:

    /tmp/laya-venv/bin/activate                 # WRONG: permission denied
    source /tmp/laya-venv/bin/activate          # right, but unnecessary here

"permission denied" on activate is expected, not a broken venv: the script is
mode 644 because it is meant to be sourced, so it has no execute bit.

Create a working directory and write the harness files below into it:

    mkdir -p /tmp/laya-validate

Check the checkpoint you intend to use exists:

    ls -d ~/.cache/huggingface/hub/models--*/snapshots/*/

This recipe was verified against a locally cached CONVERTED multilingual
checkpoint (originally convaiinnovations/laya-multilingual, NOT the
convaiinnovations/laya that serve_judge.py defaults to):

    ~/.cache/huggingface/hub/models--aac6fef--laya-multilingual-mlx/snapshots/f2b4faf51023039425946074e2cf1361d2db11d5

Adjust --model below if yours differs.

Ports used: 8081 judge, 8890 echo upstream, 8899 proxy. All loopback.


--- FILE: /tmp/laya-validate/echo_upstream.js ---------------------------------
Save this. It is a dumb upstream that records the request body it receives and
replies with a minimal Anthropic message. It is how you prove erasure happened:
the proxy log alone is not sufficient evidence.

    cat > /tmp/laya-validate/echo_upstream.js <<'JSEOF'
// Dumb upstream: records the request body it received, replies with a minimal
// Anthropic message. Lets us see what the proxy actually forwarded.
const http = require('http');
const fs = require('fs');
const OUT = '/tmp/laya-validate/last_upstream_body.json';

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    fs.writeFileSync(OUT, raw);
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
    const names = Array.isArray(parsed.tools)
      ? parsed.tools.map((t) => (t.function && t.function.name) || t.name || Object.keys(t)[0]).join(',')
      : '(no tools field)';
    console.log(`[echo] ${req.method} ${req.url} tools=[${names}]`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_echo', type: 'message', role: 'assistant',
      model: parsed.model || 'echo-1',
      content: [{ type: 'text', text: 'echo ok' }],
      stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
}).listen(8890, '127.0.0.1', () => console.log('[echo] listening on http://127.0.0.1:8890'));
JSEOF


--- FILE: /tmp/laya-validate/proxy_config.toml -------------------------------
Note timeout_ms = 50 here, the shipped default, so this config also exercises
the real-world timeout budget. Raise it if you see "judged 0/N - failing open".

    cat > /tmp/laya-validate/proxy_config.toml <<'TOMLEOF'
[general]
store_key_in_system = false

[tool_judge_sidecar]
judge_url = "http://127.0.0.1:8081"
timeout_ms = 50
threshold = 0.5
mode = "choice"
max_batch_tools = 50

[models.echo]
upstream_mode = "anthropic-messages"
base_url = "http://127.0.0.1:8890"
api_key = "local-test-key"
"echo-1" = {}
TOMLEOF


--- FILE: /tmp/laya-validate/request.json ------------------------------------
Claude-shaped body with two tools. "Read" is irrelevant to the weather prompt
and is the one expected to be erased; "get_weather" is relevant and kept.

    cat > /tmp/laya-validate/request.json <<'JSONEOF'
{
  "model": "echo-1",
  "max_tokens": 64,
  "messages": [{ "role": "user", "content": "What is the weather in Paris today?" }],
  "tools": [
    { "name": "Read", "description": "Read a file from the local filesystem.",
      "input_schema": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] } },
    { "name": "get_weather", "description": "Get the current weather for a city.",
      "input_schema": { "type": "object", "properties": { "city": { "type": "string" } }, "required": ["city"] } }
  ]
}
JSONEOF


--- FILE: /tmp/laya-validate/judge_req.json ----------------------------------
Hand-written request for Layer A, so you can test the judge without the proxy.

    cat > /tmp/laya-validate/judge_req.json <<'JSONEOF'
{"state":"User: What is the weather in Paris today?\n\nQuestion: Should this tool be kept or discarded based on the user prompt and context?\nTool:\n1. Read\n   - Read a file from the local filesystem.","questions":{"decision":{"type":"choice","instructions":"Should this tool be kept or discarded based on the user prompt and context?","criteria":["keep","discard"]}}}
JSONEOF

NOTE: the question key is "instructions" (PLURAL). Singular "instruction" makes
Laya raise ValueError("Question is missing instructions"), and the wrapper maps
that to HTTP 400.


-------------------------------------------------------------------------------
1. LAYER A -- JUDGE SIDECAR ALONE
-------------------------------------------------------------------------------

Start it (from the repo root; PYTHONPATH is required to import laya_mlx):

    cd submodules/laya-mlx
    PYTHONPATH=$PWD HF_HUB_OFFLINE=1 /tmp/laya-venv/bin/python serve_judge.py \
      --model ~/.cache/huggingface/hub/models--aac6fef--laya-multilingual-mlx/snapshots/f2b4faf51023039425946074e2cf1361d2db11d5 \
      --port 8081 --verbose

EXPECT A ~35 SECOND COLD START. The log shows:

    13:28:41,413 INFO loading <checkpoint> (dtype=float16, device=gpu)
    13:29:16,927 INFO listening on http://127.0.0.1:8081 (model_version=<checkpoint>)

Nothing answers /health until the load finishes -- deliberate, so a broken
checkpoint fails loudly at startup instead of 500-ing every request.

Wait for readiness:

    curl -sf --retry 90 --retry-delay 2 --retry-connrefused \
      http://127.0.0.1:8081/health

PASS:

    {"status": "healthy", "model_version": "<checkpoint>", "mode": "choice+noul"}

Then the real call:

    curl -s -X POST http://127.0.0.1:8081/judge \
      -H 'content-type: application/json' \
      --data @/tmp/laya-validate/judge_req.json

PASS:

    {"decision":{"type":"choice","confidence":0.5685,
                 "action":{"act_probability":1.0},
                 "choice":"discard",
                 "probabilities":{"keep":0.0885,"discard":0.9115}}}

Error paths -- both should be 400, not 500:

    curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8081/judge \
      -H 'content-type: application/json' -d '{"state":"x"}'
    # expect 400: {"error":"Request is missing a non-empty 'questions' object"}


-------------------------------------------------------------------------------
2. LAYER B -- FULL PROXY PATH  (the validation that actually matters)
-------------------------------------------------------------------------------

Three processes. Start them in this order.

(a) Echo upstream:

    node /tmp/laya-validate/echo_upstream.js > /tmp/laya-validate/echo.log 2>&1 &
    curl -sf --retry 20 --retry-delay 1 --retry-connrefused http://127.0.0.1:8890/ >/dev/null \
      && echo "echo up"

(b) Judge (from Layer A above -- leave it running).

(c) Proxy, with an explicit config path so your real config is untouched:

    PROXY_CONFIG_PATH=/tmp/laya-validate/proxy_config.toml \
    PORT=8899 DEV_NO_KEY=true LOG_LEVEL=debug \
    npx tsx src/server.ts > /tmp/laya-validate/proxy.log 2>&1 &

Confirm it is listening. NOTE: the proxy has no /health route -- `curl -sf
http://127.0.0.1:8899/health` exits 22, which is not a proxy fault. Use either
the socket or the startup line the proxy actually logs:

    lsof -nP -iTCP:8899 -sTCP:LISTEN
    grep "Server running on" /tmp/laya-validate/proxy.log
    # Server running on http://0.0.0.0:8899 (version: ...)

Now send the request:

    curl -s -X POST http://127.0.0.1:8899/v1/messages \
      -H 'content-type: application/json' \
      -H 'x-api-key: local-test-key' \
      --data @/tmp/laya-validate/request.json -o /tmp/laya-validate/resp.json \
      -w 'HTTP %{http_code}\n'

PASS REQUIRES BOTH OF THE FOLLOWING.

(1) The proxy log shows judge activity:

    grep -i "judge\|erased" /tmp/laya-validate/proxy.log
    # [INFO] Tool judge sidecar (mode=choice, threshold=0.5): 2/2 judged, 1 to erase in 68ms
    # [INFO] Erased blocked tools from request: Read

(2) The upstream received the PRUNED tool list:

    python3 -c "
    import json
    b = json.load(open('/tmp/laya-validate/last_upstream_body.json'))
    print('tools:', [t.get('name') for t in b.get('tools', [])])
    print('tool_choice:', b.get('tool_choice'))
    "
    # tools: ['get_weather']
    # tool_choice: None

If (1) is absent the judge never ran -- check the config-loader prerequisite at
the top of this file, and re-check that the TOML parses. If (1) says
"0/N judged ... failing open", the judge was too slow: raise timeout_ms.

Run it a few times to confirm it is not a one-off:

    for i in 1 2 3; do
      rm -f /tmp/laya-validate/last_upstream_body.json
      curl -s -X POST http://127.0.0.1:8899/v1/messages \
        -H 'content-type: application/json' -H 'x-api-key: local-test-key' \
        --data @/tmp/laya-validate/request.json -o /dev/null \
        -w "run$i HTTP %{http_code} in %{time_total}s\n"
      python3 -c "
      import json; b=json.load(open('/tmp/laya-validate/last_upstream_body.json'))
      print('   upstream tools:', [t.get('name') for t in b.get('tools',[])])"
    done

Verified result: 3/3 runs erased Read, upstream tools ['get_weather'] every time.


-------------------------------------------------------------------------------
3. LAYER C -- CLIENT UNIT PATH (optional, weaker)
-------------------------------------------------------------------------------

Drives judgeTools directly over HTTP, constructing the config in code. Useful
for isolating the client, but it passes even when the proxy wiring is dead,
because it never reads a config file. Layer B is the real check.

MUST BE RUN FROM THE REPO ROOT. This file is written to /tmp, so a relative
import would resolve against /tmp/laya-validate -- not the cwd. The script below
therefore resolves the client module against process.cwd(), which only works if
you `cd` to the repo root first. Run from anywhere else and it fails loudly with
MODULE_NOT_FOUND naming the directory it looked in.

    cat > /tmp/laya-validate/e2e_judge.ts <<'TSEOF'
/**
 * End-to-end: proxy's judge client -> live serve_judge.py -> Laya.
 * Not part of the repo test suite; a one-off integration check.
 * Run from the REPO ROOT:
 *   cd <repo root> && npx tsx /tmp/laya-validate/e2e_judge.ts
 */
import assert from 'node:assert/strict';

async function main() {
  // Resolved against the cwd on purpose: this file lives in /tmp, so a relative
  // specifier would resolve to /tmp/laya-validate/src/... and fail. This is why
  // the script must be run from the repo root.
  const { judgeTools } = await import(
    `${process.cwd()}/src/utils/tool-judge-sidecar.js`
  );

  const body = {
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'What is the weather in Tokyo right now?' }],
    tools: [
      { name: 'Read', input_schema: { type: 'object',
          properties: { file_path: { type: 'string', description: 'Path to read' } },
          required: ['file_path'] } },
      { name: 'get_weather', input_schema: { type: 'object',
          properties: { city: { type: 'string', description: 'City name' } },
          required: ['city'] } },
    ],
  };

  // A generous timeout on purpose: this layer tests the client's parsing, not
  // its latency budget. Layer B is where timeout_ms is exercised for real.
  // 30_000 also probes the ceiling rule: the 2000 ms cap bounds the per-question
  // SCALING only, so a base already above it is used as-is, not shrunk to 2000.
  function cfg(mode: 'choice' | 'noul') {
    return { tool_judge_sidecar: { judge_url: 'http://127.0.0.1:8081',
      timeout_ms: 30_000, threshold: 0.5, mode } } as never;
  }

  for (const mode of ['choice', 'noul'] as const) {
    for (let run = 1; run <= 2; run++) {
      const startedAt = Date.now();
      const result = await judgeTools(body as never, cfg(mode), `e2e-${mode}-${run}`);
      const elapsed = Date.now() - startedAt;
      console.log(`\n[${mode} run ${run}] ${elapsed}ms called=${result.called} error=${result.error ?? 'none'}`);
      console.log(`  erase    = ${JSON.stringify(result.eraseNames)}`);
      console.log(`  judged   = ${JSON.stringify(result.judgedNames)}`);
      console.log(`  unjudged = ${JSON.stringify(result.unjudgedNames)} skipped=${JSON.stringify(result.skippedNames)}`);
      assert.equal(result.called, true, 'sidecar was reached');
      assert.deepEqual([...result.judgedNames].sort(), ['Read', 'get_weather'], 'both tools judged');
      assert.deepEqual(result.unjudgedNames, [], 'nothing unjudged');
      assert.equal(result.error, undefined, 'no error');
      if (mode === 'choice') {
        assert.ok(result.eraseNames.includes('Read'), 'weather prompt does not need Read -> erased');
        assert.ok(!result.eraseNames.includes('get_weather'), 'get_weather must survive');
      }
    }
  }

  // Informational: a prompt that needs no tool at all. Erasing nothing here is
  // correct behaviour, not a failure, so this is NOT asserted.
  const chatBody = { ...body, messages: [{ role: 'user', content: 'Say hello in one word.' }] };
  for (const mode of ['choice', 'noul'] as const) {
    const result = await judgeTools(chatBody as never, cfg(mode), `e2e-chat-${mode}`);
    console.log(`\n[${mode} no-tool prompt] called=${result.called} erase=${JSON.stringify(result.eraseNames)} judged=${JSON.stringify(result.judgedNames)}`);
  }

  console.log('\nend-to-end OK');
}

main().catch((e) => { console.error(e); process.exit(1); });
TSEOF

    cd /path/to/repo-root        # REQUIRED -- the script resolves the client
                                 # module via process.cwd(), not its own dir
    npx tsx /tmp/laya-validate/e2e_judge.ts

PASS: every run asserts, then ends with "end-to-end OK", e.g.

    [choice run 1] 34ms called=true error=none
      erase    = ["Read"]
      judged   = ["Read","get_weather"]
      unjudged = [] skipped=[]
    [noul run 1] 33ms called=true error=none
      erase    = []
    ...
    end-to-end OK

Read the asserts carefully before trusting this layer: it checks that BOTH tools
came back judged with no unjudged and no error, and only in "choice" mode does it
require Read to be erased. So a judge that answers but discriminates badly still
passes here -- which is exactly why Layer B's upstream-body check is the one that
counts.

NOTE: this script is deliberately NOT added to tests/ -- it needs a 647 MB Laya
checkpoint and ~35 s of model load, so it cannot run in CI.


-------------------------------------------------------------------------------
4. OPERATIONAL NOTES (measured, not theoretical)
-------------------------------------------------------------------------------

COLD START: ~35 s to load the checkpoint and bind. Budget for it. The server now
warms itself first (one throwaway inference per question type, ~70 ms) before
binding the port, so the first real request is not the one that pays MLX's lazy
pipeline setup (`--no-warmup` skips it).

timeout_ms IS A PER-QUESTION BUDGET, NOT A PER-TOOL-SET ONE.
  "noul" mode packs one question PER TOOL into a SINGLE request. A flat budget
  would therefore make a bigger batch MORE likely to time out than a one-tool
  request -- exactly backwards. So the client gives a request N x timeout_ms for
  N questions, capped at 2000 ms total (requestTimeoutMs, in
  src/utils/tool-judge-sidecar.ts).
  => "choice" mode asks one question per request, so each individual request gets
     the plain timeout_ms -- but the tool-set as a whole still spends N of them
     in sequence. Observed: "1 to erase in 68ms" under a timeout_ms = 50 config,
     with per-request times of 15-39 ms.
  => The cap bounds the SCALING only: a configured timeout_ms already above
     2000 ms is never shrunk to it.
  => If you see "judged 0/N - failing open", RAISE timeout_ms. Do not conclude
     the judge is broken.
  The default 50 ms is fine on a warm judge; 3/3 runs judged 2/2 at that setting
  on this machine.

MODE RECOMMENDATION: keep "choice" (the default).
  On the cached aac6fef/laya-multilingual-mlx checkpoint, "noul" discriminated
  poorly: for the weather prompt with Read attached it scored Read at
  noul=0.7051 with threshold=0.5, so nothing was erased -- where "choice" erased
  Read on the same state. The doc's "noul" instruction wording may be too weak a
  prompt for this model. Re-tune before using noul in anger.

A PROMPT NEEDING NO TOOL ERASES NOTHING, in either mode. That is correct
behaviour, not a failure: "Say hello in one word" kept both tools.

WHERE THE JUDGE RUNS: src/index.ts before_upstream hook, after privacy filtering
and transforms, before the static tool blocklist (eraseBlockedTools). It is not
a builtin transform. Only certain routes are gated in -- /v1/messages,
/v1/responses(+/compact,/input_tokens), /v1/chat/completions,
/v1/interactions, and the Gemini generateContent/streamGenerateContent/
countTokens paths.

FAIL-OPEN BY DESIGN: on 4xx/5xx/timeout/malformed response, tools are KEPT.
Since the fix, this is reported rather than silent -- the summary line carries
counts of unjudged and over-max_batch_tools tools, and a total failure logs
"Sidecar judged none of N tools — failing open" at warn level.

TOOLS OVER max_batch_tools ARE KEPT, not judged, and counted in the log line.


-------------------------------------------------------------------------------
5. CLEANUP
-------------------------------------------------------------------------------

DO NOT use pkill. Find the PID by port, then kill it:

    for p in 8899 8081 8890; do
      pid=$(lsof -nP -iTCP:$p -sTCP:LISTEN -t 2>/dev/null)
      [ -n "$pid" ] && { echo "killing port $p pid $pid"; kill $pid; }
    done

Confirm nothing is left:

    lsof -nP -iTCP:8899 -iTCP:8081 -iTCP:8890 -sTCP:LISTEN   # expect no output
    pgrep -fl "serve_judge|echo_upstream|tsx src/server"     # expect no output


-------------------------------------------------------------------------------
6. TROUBLESHOOTING
-------------------------------------------------------------------------------

SYMPTOM: proxy returns 200 fast, both tools reach upstream, NO judge line in
         the proxy log.
CAUSE:   the [tool_judge_sidecar] section was not parsed, so judgeTools took its
         !sidecarConfig?.judge_url early return. Historically this was SILENT --
         an unknown TOML section falls through to a bare `continue`, so
         parseSimpleToml returned tool_judge_sidecar: undefined with
         _validationErrors and _validationWarnings both EMPTY.
CHECK:   grep -n "tool_judge_sidecar" src/utils/config-loader.ts
         and confirm the dispatch + two value-assign branches exist.

SYMPTOM: "Tool judge sidecar (...): 0/2 judged, 2 unjudged (kept)" or
         "failing open".
CAUSE:   judge slower than timeout_ms, or not running.
CHECK:   curl -s http://127.0.0.1:8081/health ; raise timeout_ms.

SYMPTOM: judge exits at startup / every request 500s.
CAUSE:   bad --model path or missing MLX.
CHECK:   the traceback in the judge log; confirm /tmp/laya-venv/bin/python -c
         "import mlx" works and the checkpoint directory is non-empty.

SYMPTOM: HTTP 400 from /judge with "missing instructions".
CAUSE:   question used "instruction" (singular). Must be "instructions".

SYMPTOM: "ModuleNotFoundError: No module named 'laya_mlx'".
CAUSE:   PYTHONPATH not set. Run from submodules/laya-mlx with PYTHONPATH=$PWD.

SYMPTOM: "Top-level await is currently not supported with the cjs output".
CAUSE:   tsx script under /tmp. Wrap the body in `async function main() {}`.


-------------------------------------------------------------------------------
7. KNOWN OPEN QUESTIONS (all five are now resolved)
-------------------------------------------------------------------------------

RESOLVED since this file was written:

1. Gemini tool-schema key: the judge read `function_declarations` while the real
   wire format is `functionDeclarations` (src/utils/tool-blocklist.ts already
   read it correctly). Fixed. On a Gemini-native request the judge extracted no
   tools at all and kept every one, and the dashboard logged the request as
   tool-less. Both now read the camelCase key.
2. extractTools (judge) vs extractToolNamesFromBody (dashboard-stats.ts:917)
   were near-duplicates. Fixed, and there were four copies of the rule, not two
   (the second inlined in extractToolRequestCharLengthsFromBody, the fourth in
   tool-blocklist.ts). All four now go through src/utils/tool-shapes.ts, with the
   per-caller trimming and sentinel behaviour kept in thin adapters.
3. Unknown TOML sections were accepted silently, and worse than "dropped":
   src/utils/config-loader.ts dispatched on parts[0] with no terminal `else`, so
   an unrecognised `[section]` left `currentSection` pointing at the PREVIOUS
   section and every following key-value line was absorbed into it --
   mis-attributed, not discarded. That is what hid the bug above. Fixed: the
   dispatch chain now ends in an `else` that records a warning naming the
   section and its source line, then points `currentSection` at nothing so the
   keys are dropped. A bare `[transforms]` (which needs a `.name`) is treated
   the same way. The warning goes into `_validationWarnings`, so it reaches both
   the `[WARN] <section>: …` log line and the `Result: N errors, M warnings`
   count that `proxy config validate` prints (src/cli.ts:431) -- a bare
   console.warn would reach the log and nothing else. Confirmed against every
   TOML in the repo: none emits the warning, including the serializer's own
   output.

RESOLVED since this file was written (continued):

4. Gemini bodies carry `contents`, not `messages`, so the judge used to see a
   Gemini request's tools but not its prompt or context. Fixed: buildStateText
   goes through conversationTurns(), which falls back to body.contents and maps
   Gemini's `model` role to assistant and its `parts` to the message content
   (messages wins when a body carries both). See the CHANGELOG entry for the
   Gemini tool-schema/prompt-context fix.
5. Design doc 2.2's "Tool:/Schema:" state example contradicted 4.1's numbered
   form. Fixed in the design doc itself, which now shows the numbered
   "Tools to evaluate:\n1. name: {schema}" form the client actually emits
   (src/utils/tool-judge-sidecar.ts buildStateText).
