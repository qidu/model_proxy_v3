/**
 * Multi-agent, multi-model test.
 *
 * Runs five agent SDKs (OpenAI Codex, Anthropic Claude, Google Gemini,
 * Earendil Works Pi, OpenCode) against eight models with diverse prefixes
 * through the local proxy (127.0.0.1:7777).
 *
 * Each agent receives every task in `USER_TASKS`, and every model is exercised
 * against every task, producing `len(USER_TASKS) * len(MODELS) * 5` total runs
 * (modulated by the CLI selection below).
 *
 * Testing Sever:
 *   `/v1/chat/completions` endpoint is enabled by default
 *   start proxy with `DEV_NO_KEY=true` to skip auth headers checking on proxy
 *   start proxy with `PORT=7777` on testing port, use lsof to check testing port and get right pid of proxy
 *
 * Usage:
 *
 *   export API_KEY=a-valid-key
 *   export CODEX_API_KEY=$API_KEY
 *   export ANTHROPIC_API_KEY=$API_KEY
 *   export GEMINI_API_KEY=$API_KEY
 *   export PI_API_KEY=$API_KEY
 *
 *   export ANTHROPIC_API_KEY="sk-hi"
 *   npx tsx tests/multi-agents-test.ts              # all models x agents x all tasks
 *   npx tsx tests/multi-agents-test.ts 1 1 1        # first model, first agent, first task
 *   npx tsx tests/multi-agents-test.ts 2 3 1        # 2nd model, 3rd agent, 1st task
 *   npx tsx tests/multi-agents-test.ts 0 0 2        # all models, all agents, 2nd task
 *   npx tsx tests/multi-agents-test.ts 9 4 0        # MODELS[(9-1) % len], AGENTS[(4-1) % 5], all tasks
 *
 *   Set keys for each agent sdk:
 *   // await runCodexAgent(task, model);    // export CODEX_API_KEY=a-valid-key
 *   // await runClaudeAgent(task, model);   // export ANTHROPIC_API_KEY=a-valid-key
 *   // await runGeminiAgent(task, model);   // export GEMINI_API_KEY=a-valid-key
 *   // await runPiAgent(task, model);       // export PI_API_KEY=a-valid-key
 *   // await runOpenCodeAgent(task, model); // OpenCode reads OPENCODE_API_KEY or uses OPENCODE_CONFIG_CONTENT
 *
 *   // or export API_KEY=a-valid-key for all of them.
 *
 *   CLI selection semantics:
 *     - no args                                -> list available models, agents, and tasks; do not run
 *     - --all / -a / --run / -r               -> run all models x all agents x all tasks
 *     - M A T (three numeric args)             -> run selected subset; 1-based with wrap
 *         "0 0 0"                              -> same as --all
 *         M A T with M,A,T > 0                -> MODELS[(M-1) % MODELS.length],
 *                                                AGENTS[(A-1) % AGENTS.length],
 *                                                USER_TASKS[(T-1) % USER_TASKS.length]
 *         0 in any position                   -> that dimension runs all entries
 *                                                (e.g. "0 1 0" = all models, first agent, all tasks)
 *
 *   Agent order:  1=Codex, 2=Claude, 3=Gemini, 4=Pi, 5=OpenCode
 *
 *   To restrict the static task list, comment entries in USER_TASKS below.
 */

import { GoogleGenAI, Type } from "@google/genai";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PROXY_BASE = process.env.PROXY_BASE || "http://127.0.0.1:7777";
const WORK_DIR = "./tests/";

const MODELS = [
  "kimi-k3-qn",
  "deepseek-v4-comp",               // deepseek via openai-completions
  "deepseek-v4-anth",               // deepseek via anthropic-messages
  "max-m3-comp",                    // minimax via openai-completions
  "max-m3-anth",                    // minimax via anthropic-messages
  "glm-5.3-comp",                   // z-ai glm via openai-completions (stateful /v1/responses)
];

// Each task targets a different AI-coding / agent capability so model
// differences surface clearly. All tasks operate against ./tests/ (WORK_DIR).
// Tasks are tuned to require real tool use (multi-glob + multi-read) rather
// than a single guess.
const USER_TASKS: { name: string; prompt: string }[] = [
  {
    name: "codebase_layout",
    prompt:
      "Analyze the codebase file structure in ./tests/ and report layout suggestions. " +
      "Group files by purpose (api handlers, fixtures, scripts, feature suites, etc.) " +
      "and flag anything that looks misplaced.",
  },
  {
    name: "duplicate_helpers",
    prompt:
      "Search ./tests/ for helper functions that are duplicated across multiple test files " +
      "(e.g. identical curl wrappers, retry loops, or auth-header builders). Read the " +
      "suspected duplicates and confirm whether they are truly identical or only superficially " +
      "similar. Report a deduplication plan naming the files involved.",
  },
  {
    name: "stale_or_dead_tests",
    prompt:
      "Audit ./tests/ for stale or dead test cases: shell scripts with hard-coded absolute " +
      "paths that no longer exist, files referencing removed endpoints, or commented-out " +
      "test blocks left behind. Report each finding with the file path and a one-line " +
      "recommendation (delete / fix / keep).",
  },
  {
    name: "coverage_matrix",
    prompt:
      "Build a coverage matrix: for each test file under ./tests/, list which endpoint or " +
      "feature it covers (e.g. /v1/messages, streaming, routing). Group similar files and " +
      "call out obvious coverage gaps — features mentioned in README.md that have no test " +
      "file backing them.",
  },
  {
    name: "hardcoded_credentials",
    prompt:
      "Security review: scan ./tests/ for hard-coded credentials, API keys, tokens, or " +
      "secrets that should not be committed to source control. List each finding with file " +
      "path, line context, and severity (high if it looks like a real key, low if it is " +
      "clearly a placeholder like 'sk-test' or 'YOUR_API_KEY').",
  },
  {
    name: "extract_shared_utilities",
    prompt:
      "Read a representative sample of test files under ./tests/ and identify utilities that " +
      "should be extracted into a shared module (e.g. proxy startup helpers, curl wrappers, " +
      "JSON assertion helpers). Propose a small refactor: which functions move, where they " +
      "live, and which call sites get simplified.",
  },
  {
    name: "convention_violations",
    prompt:
      "Review naming and structural conventions in ./tests/: file naming (snake_case vs " +
      "kebab-case vs camelCase), script header style (shebang + cd / export), and how " +
      "test setup is performed. Report inconsistencies grouped by convention type, with " +
      "a recommended standard for each.",
  },
  {
    name: "dependency_audit",
    prompt:
      "Find every external package or CLI tool referenced from test scripts under ./tests/ " +
      "(e.g. curl, jq, node, npm, tsx). For each, note whether the test assumes a specific " +
      "version or path, and flag any that look fragile or undocumented.",
  },
];

// ---------------------------------------------------------------------------
// Shared tool implementations
// ---------------------------------------------------------------------------

function toolGlobSync(pattern: string, maxResults = 100): string[] {
  // Convert glob to regex: ** → everything, * → non-separator, ? → single char
  const regexStr =
    "^" +
    pattern
      .replace(/\*\*/g, "☃")
      .replace(/\*/g, "[^/]*")
      .replace(/☃/g, ".*")
      .replace(/\?/g, ".") +
    "$";
  const regex = new RegExp(regexStr);
  const results: string[] = [];

  function walk(dir: string) {
    if (results.length >= maxResults) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= maxResults) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith(".")) continue; // skip hidden
        walk(full);
      } else if (e.isFile() || e.isSymbolicLink()) {
        if (regex.test(full)) results.push(full);
      }
    }
  }

  walk(WORK_DIR);
  return results.slice(0, maxResults);
}

async function toolGlob(pattern: string): Promise<string> {
  return JSON.stringify(toolGlobSync(pattern), null, 2);
}

async function toolRead(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, "utf-8");
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

const toolMap: Record<string, (args: any) => Promise<string>> = {
  Glob: async (args: { pattern: string }) => toolGlob(args.pattern),
  Read: async (args: { path: string }) => toolRead(args.path),
};

// ---------------------------------------------------------------------------
// 1. OpenAI Codex Agent
// ---------------------------------------------------------------------------

async function runCodexAgent(prompt: string, model: string) {
  console.log(`\n--- Codex Agent | model=${model} ---`);
  const { Codex } = await import("@openai/codex-sdk");

  // Write config.toml so codex-cli points at the local proxy
  const codexDir = path.join(os.homedir(), ".codex");
  const codexConfig = path.join(codexDir, "config.toml");
  const configBody = `model = "${model}"
model_provider = "localproxy"

[model_providers.localproxy]
name = "Local Proxy"
base_url = "${PROXY_BASE}/v1"
env_key = "CODEX_API_KEY"
wire_api = "responses"
`;
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(codexConfig, configBody);

  const KEY = process.env.CODEX_API_KEY || process.env.API_KEY || "sk-agent-test-key";
  try {
    const codex = new Codex({ apiKey: KEY });
    const thread = codex.startThread({
      model,
      modelReasoningEffort: "low",
    });
    // const result = await thread.run(prompt);
    // console.log("Codex result:", result.finalResponse ?? result);

    const { events } = await thread.runStreamed(prompt);
    for await (const event of events) {
      switch (event.type) {
        case "item.started":
          break;
        case "item.completed":
          if (event.item?.type === 'command_execution') {
            console.log(`  ${event.item.command}`);
            console.log(`  (aggregated_output length: ${event.item.aggregated_output.length})`);
          }
          break;
        case "turn.completed":
            console.log("Usage:", event.usage);
            break;
        default:
            //console.log(event);
      }
    }
  } catch (error) {
    console.error("Codex failed:", error);
  }
}

// ---------------------------------------------------------------------------
// 2. Anthropic Claude Agent
// ---------------------------------------------------------------------------

async function runClaudeAgent(prompt: string, model: string) {
  console.log(`\n--- Claude Agent | model=${model} ---`);
  const { query: claudeQuery } = await import("@anthropic-ai/claude-agent-sdk");
  try {
    const stream = claudeQuery({
      prompt,
      options: {
        model,
        allowedTools: ["Glob", "Read"],
        maxTurns: 30,
        env: {
          ANTHROPIC_BASE_URL: PROXY_BASE,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || process.env.API_KEY || "sk-agent-test-key",
        },
      },
    });

    for await (const msg of stream) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if ("text" in block) console.log(block.text);
        }
      }
      if (msg.type === "result") {
        console.log(`Claude done. status=${msg.subtype}`);
      }
    }
  } catch (error) {
    console.error("Claude agent failed:", error);
  }
}

// ---------------------------------------------------------------------------
// 3. Gemini Agent  (with tool calling loop)
// ---------------------------------------------------------------------------

const GEMINI_TOOLS: Record<string, any>[] = [
  {
    functionDeclarations: [
      {
        name: "Glob",
        description: "List files matching a glob pattern under the project root",
        parameters: {
          type: Type.OBJECT,
          properties: {
            pattern: {
              type: Type.STRING,
              description: 'e.g. "tests/**/*.ts" or "src/**/*.{ts,js}"',
            },
          },
          required: ["pattern"],
        },
      },
      {
        name: "Read",
        description: "Read the full contents of a file",
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: {
              type: Type.STRING,
              description: "Absolute file path",
            },
          },
          required: ["path"],
        },
      },
    ],
  },
];

async function runGeminiAgent(prompt: string, model: string) {
  console.log(`\n--- Gemini Agent | model=${model} ---`);
  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY || process.env.API_KEY || "sk-agent-test-key",
    httpOptions: { baseUrl: PROXY_BASE },
  });

  // SAFETY: the proxy returns function calls for ANY model, but only Gemini
  // models will produce semantically meaningful function calls. For others,
  // this loop degrades gracefully: the model returns a text answer directly
  // after the first turn (no tool calls).

  const history: { role: string; parts: any[] }[] = [
    { role: "user", parts: [{ text: prompt }] },
  ];
  let completed = false;

  for (let turn = 0; turn < 20; turn++) {
    let resp;
    try {
      resp = await ai.models.generateContent({
        model,
        contents: history,
        config: {
          tools: GEMINI_TOOLS,
        },
      });
    } catch (e: any) {
      console.error(`Gemini API error: ${e?.message ?? e}`);
      return;
    }

    const candidate = resp.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    if (parts.length === 0) {
      console.log("Gemini: no candidate / empty response");
      completed = true;
      break;
    }

    const fcParts: any[] = [];
    const thoughtParts: any[] = [];
    const frParts: any[] = [];
    let sawText = false;

    for (const part of parts) {
      if (part.functionCall) {
        const fc = part.functionCall;
        const fnName = fc.name as string;
        const fnArgs = fc.args as Record<string, any> | undefined;

        console.log(`  Tool call: ${fnName}(${JSON.stringify(fnArgs ?? {})})`);

        const executor = toolMap[fnName];
        let result: string;
        if (executor) {
          result = await executor(fnArgs ?? {});
        } else {
          result = `Error: unknown tool "${fnName}"`;
        }
        const resultPreview = result.length > 1000 ? `${result.slice(0, 1000)}...` : result;
        // console.log(`  Tool result: ${resultPreview}`);

        fcParts.push({ functionCall: { name: fnName, args: fnArgs ?? {} } });
        frParts.push({
          functionResponse: {
            name: fnName,
            response: { result },
          },
        });
      } else if (part.thought && part.text !== undefined) {
        // Thinking/reasoning content from thinking-mode upstreams (e.g. DeepSeek).
        // Must be included in the model-turn history so the upstream can round-trip
        // the reasoning on the next request without rejecting with
        // "reasoning_content must be passed back".
        thoughtParts.push({ thought: true, text: part.text });
      } else if (part.text) {
        if (!sawText) console.log("Gemini output:");
        console.log(part.text);
        sawText = true;
      } else {
        console.log("Gemini: unexpected part type", JSON.stringify(part));
      }
    }

    if (fcParts.length > 0) {
      // Include thought parts before function call parts in the model history turn
      // so thinking-mode upstreams see the full assistant content (thought + tool calls).
      history.push({ role: "model", parts: [...thoughtParts, ...fcParts] });
      history.push({ role: "user", parts: frParts });
    } else {
      completed = true;
      break;
    }
  }

  if (!completed) {
    console.log("Gemini: reached 20 tool turns; forcing final output without tools");
    let finalResp;
    try {
      finalResp = await ai.models.generateContent({
        model,
        contents: [
          ...history,
          {
            role: "user",
            parts: [{ text: "No more tool calls. Provide the final answer now based on the information gathered." }],
          },
        ],
      });
    } catch (e: any) {
      console.error(`Gemini API error: ${e?.message ?? e}`);
      return;
    }
    const finalParts = finalResp.candidates?.[0]?.content?.parts ?? [];
    const textParts = finalParts.filter((part) => part.text).map((part) => part.text);
    if (textParts.length > 0) {
      console.log("Gemini output:");
      console.log(textParts.join("\n"));
    } else {
      console.log("Gemini: no final text output", JSON.stringify(finalParts));
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Earendil Works Pi Agent  (uses @earendil-works/pi-agent-core)
// ---------------------------------------------------------------------------
//
// Pi's agent SDK does not ship user-supplied tools in the same shape as
// Gemini's functionDeclarations — you write each tool as an AgentTool with
// a typebox schema + execute(). We reuse the file's existing toolGlobSync /
// toolRead helpers (declared at the top of this file) so the toolset is
// identical across Pi and the other read-only workers.
//
// Model wiring: pi's anthropic-messages API POSTs to `{baseUrl}/v1/messages`.
// The proxy accepts /v1/messages for any registered model; /v1/chat/completions
// is also served (passthrough), but this test routes via the Anthropic shape.
// pi's SDK appends "/v1/messages" to baseUrl internally, so the provider's
// baseUrl is the proxy origin (no /v1 suffix). One static model entry per
// id in MODELS is registered.

async function runPiAgent(prompt: string, model: string) {
  console.log(`\n--- Pi Agent | model=${model} ---`);
  try {
    const { Agent } = await import("@earendil-works/pi-agent-core");
    const {
      createModels,
      createProvider,
      envApiKeyAuth,
      Type,
    } = await import("@earendil-works/pi-ai");
    const { anthropicMessagesApi } = await import(
      "@earendil-works/pi-ai/api/anthropic-messages.lazy"
    );

    // The proxy accepts /v1/messages for any registered model (the only
    // /v1/chat/completions path is explicitly disabled with a 403 telling
    // callers to use /v1/messages). So we wire pi through the Anthropic
    // Messages API regardless of the underlying model's actual provider —
    // the proxy handles the cross-API translation.
    //
    // Build a static model catalog for this proxy from the shared MODELS list.
    const piModels: any[] = MODELS.map((id) => ({
      id,
      name: id,
      api: "anthropic-messages",
      provider: "anthropic",
      // Pi's anthropic client appends "/v1/messages" to baseUrl, so the
      // baseUrl is the proxy origin WITHOUT the /v1 suffix (avoids the
      // "/v1/v1/messages" doubled-path error).
      baseUrl: PROXY_BASE,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    }));

    const provider = createProvider({
      id: "anthropic",
      name: "Local Proxy (/v1/messages)",
      baseUrl: PROXY_BASE,
      // Provider.auth must be { apiKey?: ApiKeyAuth, oauth?: OAuthAuth }.
      // Passing the envApiKeyAuth object directly (no envelope) makes pi look
      // for `auth.apiKey` and silently return undefined → "Provider is not
      // configured". See Pi auth.resolve docs.
      auth: { apiKey: envApiKeyAuth("PI key", ["PI_API_KEY", "ANTHROPIC_API_KEY", "API_KEY"]) },
      models: piModels,
      api: anthropicMessagesApi(),
    });

    const models = createModels();
    models.setProvider(provider);

    const piModel = models.getModel("anthropic", model);
    if (!piModel) {
      throw new Error(`Pi: model "${model}" not registered in the static catalog`);
    }

    // Reuse the file's existing tool implementations (no duplicates — see
    // CLAUDE.md rule 4). Schema is declared with typebox Type, which is what
    // pi's AgentTool expects.
    const piTools: any[] = [
      {
        name: "Glob",
        label: "List files matching a glob pattern",
        description: "List files matching a glob pattern under ./tests/",
        parameters: Type.Object({
          pattern: Type.String({ description: 'e.g. "tests/**/*.ts"' }),
        }),
        execute: async (_id: string, args: { pattern: string }) =>
          JSON.stringify(toolGlobSync(args.pattern), null, 2),
      },
      {
        name: "Read",
        label: "Read a file",
        description: "Read the full contents of a file",
        parameters: Type.Object({
          path: Type.String({ description: "Absolute file path" }),
        }),
        execute: async (_id: string, args: { path: string }) => {
          try {
            return await fs.promises.readFile(args.path, "utf-8");
          } catch (e: any) {
            return `Error: ${e.message}`;
          }
        },
      },
    ];

    const agent = new Agent({
      initialState: {
        systemPrompt:
          "You are a code-analysis assistant. Use the provided Glob and Read " +
          "tools to inspect ./tests/ before answering. Cite file paths and line " +
          "ranges. Admit uncertainty rather than fabricating.",
        model: piModel,
        thinkingLevel: "off",
      },
      streamFn: models.streamSimple.bind(models),
      // Bypass pi's on-disk credential store (~/.pi/agent/auth.json) and
      // resolve the API key directly from the environment. Without this hook,
      // a stored OAuth credential for another provider masks our env key and
      // pi returns "Provider is not configured".
      getApiKey: async () =>
        process.env.PI_API_KEY || process.env.API_KEY || "sk-agent-test-key",
    });
    agent.state.tools = piTools;

    let finalText = "";
    let toolCalls = 0;
    agent.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        process.stdout.write(event.assistantMessageEvent.delta);
      } else if (event.type === "tool_execution_end") {
        toolCalls++;
      }
    });

    await agent.prompt(prompt);

    // Drain the final text from the agent's last assistant message so the
    // log shows the complete answer on a single block (text_delta streaming
    // may have written partial chunks to stdout already).
    const lastAssistant = [...agent.state.messages]
      .reverse()
      .find((m: any) => m.role === "assistant");
    if (lastAssistant) {
      const text = (lastAssistant.content ?? [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");
      if (text && text !== finalText) {
        finalText = text;
        if (process.stdout.writableLength === 0) console.log("");
        console.log(`Pi done. tool_calls=${toolCalls}, chars=${finalText.length}`);
      }
      // Surface upstream errors as warnings (not failures) — pi-agent-core
      // catches LLM stream errors and emits stopReason="error" on the final
      // assistant message rather than throwing. Without this log line,
      // a silent model-side failure looks identical to a successful empty
      // run.
      if (lastAssistant.stopReason === "error") {
        console.log(`Pi upstream error: ${lastAssistant.errorMessage ?? "(no message)"}`);
      }
    }
  } catch (error) {
    console.error("Pi agent failed:", error);
  }
}

// ---------------------------------------------------------------------------
// 5. OpenCode Agent  (uses @opencode-ai/sdk)
//
// OpenCode's SDK does not speak OpenAI-compatible APIs directly — it spawns
// its own server (`opencode serve`) which then forwards requests to a model
// provider. We inject our provider config via OPENCODE_CONFIG_CONTENT so the
// server talks to the local proxy at /v1.
//
// OpenCode ships its own sandboxed tool registry (read/bash/edit/write).
// We disable the write-capable tools so behavior stays read-only and
// comparable to the other workers. If the `opencode` binary is not on PATH
// (it is not always installed alongside @opencode-ai/sdk), we log a clear
// skip message and return — per CLAUDE.md rule 8 (fail loud, no silent
// default success).
// ---------------------------------------------------------------------------

async function runOpenCodeAgent(prompt: string, model: string) {
  console.log(`\n--- OpenCode Agent | model=${model} ---`);
  // `opencode` binary presence is checked at runtime by cross-spawn. Pre-check
  // here so the skip reason is visible BEFORE the 5s server-start timeout.
  // Use the ESM-imported `fs` here, NOT `require("fs")`: tsx's ESM-mode
  // `require("fs")` returns a namespace whose `existsSync` returns false for
  // `/usr/local/bin/opencode` (a symlink → `opencode.exe`) on this host even
  // though the binary is installed, which previously caused a false-negative
  // skip. The imported `fs` resolves the symlink correctly.
  const pathEnv = process.env.PATH ?? "";
  const hasBinary = pathEnv.split(":").some((dir) => {
    try {
      return fs.existsSync(`${dir}/opencode`);
    } catch {
      return false;
    }
  });
  if (!hasBinary) {
    console.error(
      "[OpenCode] `opencode` binary not found on PATH — skipping. " +
        "Install with: npm i -g opencode-ai",
    );
    return;
  }

  let server: { url: string; close: () => void } | null = null;
  try {
    const { createOpencode } = await import("@opencode-ai/sdk");

    // Configure OpenCode's server to point its provider at our proxy.
    //
    // Active provider (Anthropic mode, /v1/messages — any key accepted):
    //   npm: "@ai-sdk/anthropic"
    //   API_KEY env:  any non-empty key (e.g. export API_KEY=sk-hi)
    //
    // Alternative openai-compatible provider (/v1/chat/completions — requires
    // the dedicated sk-cp key on this proxy):
    //   npm: "@ai-sdk/openai-compatible"
    //   apiKey:        "sk-cp-p_i6lDK-***_xzjlhvQ0jblFw"
    //   baseURL:       `${PROXY_BASE}/v1`
    //   headers:       { Authorization: `Bearer <apiKey>` }
    //   options:       { setCacheKey: false, timeout: 600_000 }
    //   models:        "minimax-m3"
    //
    // Model catalog mirrors `~/.config/opencode/opencode.jsonc`: each model
    // id in MODELS is registered under proxyv3 so the caller-supplied `model`
    // is used verbatim. The proxy accepts any of these ids on /v1/messages.
    const API_KEY = process.env.OPENCODE_API_KEY || process.env.API_KEY || "sk-agent-test-key";
    const ocModelID = model;
    const ocConfig: any = {
      provider: {
        proxyv3: {
          npm: "@ai-sdk/anthropic",
          name: "proxyv3",
          options: {
            baseURL: PROXY_BASE,
            apiKey: API_KEY,
          },
          models: {
            [ocModelID]: { name: ocModelID },
          },
        },
      },
    };

    const oc = await createOpencode({ config: ocConfig, timeout: 600_000 });
    server = oc.server;

    const sessionResp: any = await oc.client.session.create({ body: {} });
    const sid = sessionResp?.data?.id ?? sessionResp?.id;
    if (!sid) throw new Error("OpenCode: session.create returned no id");

    // The SDK's `session.prompt()` hits POST `/session/{id}/message` which only
    // returns the new user-message info — the actual assistant reply and tool
    // calls stream back via `/global/event`. We subscribe first, then submit.
    const events: any[] = [];
    const eventStream: any = await oc.client.event.subscribe();
    const eventPromise = (async () => {
      try {
        for await (const ev of eventStream.stream ?? eventStream) {
          events.push(ev);
        }
      } catch (e: any) {
        // stream ended or aborted; ignore
      }
    })();

    await oc.client.session.promptAsync({
      path: { id: sid },
      body: {
        model: { providerID: "proxyv3", modelID: ocModelID },
        // Read-only parity with Codex/Claude/Gemini/Pi workers
        tools: { read: true, bash: false, edit: false, write: false, grep: true, glob: true },
        parts: [{ type: "text", text: prompt }],
      },
    });

    // Poll the session messages endpoint until the session becomes idle (no
    // more in-flight assistant message) or we hit the timeout. Each iteration
    // fetches the latest messages and checks for terminal state.
    const deadline = Date.now() + 600_000;
    let idleSeen = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const msgsResp: any = await oc.client.session.messages({ path: { id: sid } });
      const msgs: any[] = msgsResp?.data ?? [];
      const last = msgs[msgs.length - 1];
      const lastRole = last?.info?.role;
      const lastFinish = last?.info?.finish;
      // OpenCode emits an "idle" event when the session has no pending
      // assistant run; also treat the last assistant message finishing as done.
      if (events.some((e) => e?.type === "session.idle")) { idleSeen = true; break; }
      if (lastRole === "assistant" && (lastFinish === "stop" || lastFinish === "end_turn")) break;
    }

    // Final message dump.
    const finalResp: any = await oc.client.session.messages({ path: { id: sid } });
    const finalMsgs: any[] = finalResp?.data ?? [];
    const lastAssistant: any = [...finalMsgs].reverse().find((m: any) => m?.info?.role === "assistant");
    const parts: any[] = lastAssistant?.parts ?? [];
    const toolCalls = parts.filter((p: any) => p.type === "tool").length;
    const text = parts
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("\n");

    console.log(`OpenCode done. tool_calls=${toolCalls}, chars=${text.length}, idleSeen=${idleSeen}`);
    if (lastAssistant?.info?.error) {
      console.log(`OpenCode error: ${JSON.stringify(lastAssistant.info.error).slice(0, 400)}`);
    }
    if (text) console.log(text);
    else console.log("(no text output)");

    // Stop the event subscription
    try { (eventStream as any)?.close?.(); } catch { /* ignore */ }
  } catch (error) {
    console.error("OpenCode agent failed:", error);
  } finally {
    if (server) {
      try { server.close(); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Agent registry (drives the CLI `agent` selector)
// ---------------------------------------------------------------------------

const AGENTS: { name: string; run: (prompt: string, model: string) => Promise<void> }[] = [
  { name: "Codex",    run: runCodexAgent    },
  { name: "Claude",   run: runClaudeAgent   },
  { name: "Gemini",   run: runGeminiAgent   },
  { name: "Pi",       run: runPiAgent       },
  { name: "OpenCode", run: runOpenCodeAgent },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Attempt to fetch models from the proxy; fall back to hardcoded list.
  try {
    const resp = await fetch(`${PROXY_BASE}/v1/models`, {
      headers: { "x-api-key": "sk-hi" },
    });
    const data: any = await resp.json();
    const apiIds: string[] = (data.data ?? []).map((m: any) => m.id);
    if (apiIds.length > 0) {
      const preferred = [
        "deepseek",
        "minimax",
        "gemini",
        "claude",
        "gpt",
        "qwen",
        "moonshot",
        "z-ai",
      ];
      const selected: string[] = [];
      for (const prefix of preferred) {
        const match = apiIds.find(
          (id: string) =>
            id.startsWith(prefix) || id.toLowerCase().startsWith(prefix),
        );
        if (match) selected.push(match);
        if (selected.length >= 8) break;
      }
      if (selected.length > 10) {
        console.log(`Using ${selected.length} models from proxy API.`);
        for (const m of selected) console.log(`  ${m}`);
        // Replace MODELS with the dynamically fetched list
        MODELS.splice(0, MODELS.length, ...selected);
      }
    }
  } catch {
    console.log("Could not fetch models from proxy; using fallback list.");
  }

  // CLI selection:
  //   no args                  -> list available models, agents, tasks; do not run
  //   --all / -a / --run / -r  -> run all models x all agents x all tasks
  //   M A T (three numbers)    -> run selected subset (1-based, 0 = all in that dimension)
  const argv = process.argv.slice(2);
  const runFlag = argv.length > 0 && ["--all", "-a", "--run", "-r"].includes(argv[0]);
  const numericArgs = argv.length >= 3 && argv.slice(0, 3).every(a => /^-?\d+$/.test(a));

  if (argv.length === 0) {
    // List mode — no execution
    console.log("Available models:");
    MODELS.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
    console.log("\nAvailable agents:");
    AGENTS.forEach((ag, i) => console.log(`  ${i + 1}. ${ag.name}`));
    console.log("\nAvailable tasks:");
    USER_TASKS.forEach((t, i) => console.log(`  ${i + 1}. ${t.name}`));
    console.log("\nRun with --all / -a / --run / -r to execute, or pass M A T (three numbers) to select a subset:");
    console.log("  M = model index (1-based), A = agent index, T = task index; 0 means all in that dimension.");
    return;
  }

  let modelsToRun: string[] = MODELS;
  let agentsToRun = AGENTS;
  let tasksToRun = USER_TASKS;

  if (numericArgs) {
    const m = parseInt(argv[0], 10);
    const a = parseInt(argv[1], 10);
    const t = parseInt(argv[2], 10);
    if (Number.isFinite(m) && m > 0) modelsToRun = [MODELS[(m - 1) % MODELS.length]];
    if (Number.isFinite(a) && a > 0) agentsToRun = [AGENTS[(a - 1) % AGENTS.length]];
    if (Number.isFinite(t) && t > 0) tasksToRun = [USER_TASKS[(t - 1) % USER_TASKS.length]];
  }
  // runFlag uses all defaults (all models x all agents x all tasks)

  console.log(
    `Selection: ${modelsToRun.length} model(s) x ${agentsToRun.length} agent(s) x ${tasksToRun.length} task(s) at ${PROXY_BASE}`,
  );
  for (const m of modelsToRun) console.log(`  model:  ${m}`);
  for (const ag of agentsToRun) console.log(`  agent:  ${ag.name}`);
  for (const t of tasksToRun) console.log(`  task:   ${t.name}`);

  for (const task of tasksToRun) {
    for (const model of modelsToRun) {
      console.log(
        `\n=========== Task: ${task.name} | Model: ${model} ===========`,
      );
      const prompt = task.prompt;
      for (const agent of agentsToRun) {
        await agent.run(prompt, model);
      }
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
