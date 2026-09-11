/**
 * Hand-authored tools for the interactive AGENT=true session (see src/agent-session.ts).
 *
 * Deliberately minimal — read_file/write_file/bash, plus find_skill/add_skill when the
 * `skills` CLI (vercel-labs/skills, npm package "skills") is available. No speculative
 * surface beyond that. pi-coding-agent ships a similar read/write/bash set but isn't
 * installed here (large CLI/TUI dependency tree we don't otherwise need), so these are
 * built directly against pi-agent-core's AgentTool shape.
 *
 * All paths are resolved relative to `workDir`, the working directory the user
 * picked (or the /tmp fallback) at session start — never process.cwd() directly.
 *
 * write_file and bash's rm/mv are confined to workDir plus the real /tmp/ tree
 * (isPathAllowed) — writes/deletes/moves outside both are blocked outright.
 * bash also blocks a small denylist of destructive command patterns regardless
 * of path (rm -rf, kill -9, force push, chmod -R 777, curl|sh). All of this is
 * raw-string/regex-based, not a real shell parser — see the comments above
 * DANGEROUS_COMMAND_PATTERNS and isPathAllowed for the accepted tradeoffs.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { loadSkills, formatSkillInvocation } from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { Type, type Static } from 'typebox';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { realpathSync } from 'fs';
import { basename, dirname, isAbsolute, resolve, sep } from 'path';
import { execFile } from 'child_process';
import { tmpdir } from 'os';

const BASH_TIMEOUT_MS = 60_000;
const BASH_MAX_BUFFER = 10 * 1024 * 1024;
const SKILL_TIMEOUT_MS = 60_000;
const SKILL_MAX_BUFFER = 10 * 1024 * 1024;
const MAX_SKILLS = 5;

function resolveInWorkDir(workDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(workDir, path);
}

// os.tmpdir() is the actual OS temp root (e.g. /var/folders/.../T on stock
// macOS, /tmp when $TMPDIR is overridden) — NOT necessarily the literal
// string "/tmp". Both the raw form and its realpath'd form (e.g. macOS's
// /tmp -> /private/tmp symlink) are accepted as roots below: a target path
// may arrive already resolved through the symlink, or not, and we can't
// realpath a target that doesn't exist yet (e.g. a file about to be
// created), so both variants of the root are checked instead.
const TMP_ROOT_RAW = tmpdir();
const TMP_ROOT_REAL = (() => {
  try {
    return realpathSync(TMP_ROOT_RAW);
  } catch {
    return TMP_ROOT_RAW;
  }
})();

function underRoot(resolved: string, root: string): boolean {
  return resolved === root || resolved.startsWith(root + sep);
}

// Resolves symlinks in `targetPath` as far as the filesystem allows. A purely
// lexical resolve() is not enough for confinement: a symlink *inside* workDir
// pointing outside it (which the agent can create itself — `ln -s` is on no
// denylist) resolves lexically to an in-scope path, while the actual write
// follows the link and lands outside both allowed roots.
//
// realpath() fails on a path that doesn't exist yet (the common write_file
// case: creating a new file), so walk up to the deepest ancestor that does
// exist, realpath *that*, and re-append the not-yet-existing tail. The tail
// can't itself be a symlink — it doesn't exist — so this is sufficient, and
// it catches a symlinked parent directory as well as a symlinked leaf.
function realpathBoundary(targetPath: string): string {
  let current = resolve(targetPath);
  const trailing: string[] = [];
  for (;;) {
    try {
      // slice() first — this runs inside a retry loop, and reversing
      // `trailing` in place would corrupt it for the next attempt.
      return resolve(realpathSync(current), ...trailing.slice().reverse());
    } catch {
      const parent = dirname(current);
      // Reached the filesystem root without finding an existing ancestor —
      // fall back to the lexical form rather than looping forever.
      if (parent === current) return resolve(targetPath);
      trailing.push(basename(current));
      current = parent;
    }
  }
}

// Confines writes/deletes/moves to workDir plus the real OS tmp tree (a
// second always-allowed root — covers the Section 3 /tmp/task-<id> fallback
// dir too, since workDir is one of the two allowed roots regardless of where
// it lives). Both the lexical and the symlink-resolved form of the target must
// be in scope: the lexical check alone is bypassable via a symlink (see
// realpathBoundary), and requiring both means a link can only ever narrow what
// is reachable, never widen it.
function isPathAllowed(workDir: string, targetPath: string): boolean {
  const resolvedWorkDir = realpathBoundary(workDir);
  const inScope = (candidate: string): boolean =>
    underRoot(candidate, resolvedWorkDir) ||
    underRoot(candidate, TMP_ROOT_RAW) ||
    underRoot(candidate, TMP_ROOT_REAL);
  return inScope(resolve(targetPath)) && inScope(realpathBoundary(targetPath));
}

function runCli(command: string, args: string[], cwd: string, timeoutMs: number, maxBuffer: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, { cwd, timeout: timeoutMs, maxBuffer }, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(new Error(`${command} ${args.join(' ')} failed: ${error.message}${stderr ? `\n${stderr}` : ''}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

// Narrow, hardcoded denylist for the bash tool. Not a real shell parser — matches
// on the raw command string, so determined obfuscation (quoting tricks, variable
// indirection) can evade it. That's an accepted tradeoff: the goal is to stop the
// agent from accidentally running an obviously destructive command it explicitly
// decided to type, not to sandbox an adversarial actor — bash already runs with
// the operator's own shell privileges in workDir. Blocks outright (throws), no
// override/bypass flag. See plan Section 11 for the rationale and scope.
const DANGEROUS_COMMAND_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s/, reason: 'recursive force delete (rm -rf)' },
  { pattern: /\bkill\s+(-9|-KILL|-s\s*KILL)\b/, reason: 'unconditional process kill (kill -9)' },
  { pattern: /\bgit\s+push\b.*(--force\b|-f\b)/, reason: 'force push (can overwrite remote history)' },
  { pattern: /\bchmod\s+-R\s+777\b/, reason: 'recursive world-writable permissions (chmod -R 777)' },
  { pattern: /\bcurl\b[^|]*\|\s*(sh|bash|zsh)\b|\bwget\b[^|]*\|\s*(sh|bash|zsh)\b/, reason: 'piping a remote download directly into a shell' },
];

function findDangerousPattern(command: string): string | null {
  for (const { pattern, reason } of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

// Matches a bare `rm <args...>` or `mv <args...>` invocation at the start of a
// command segment, capturing every space-separated token after the verb.
// Raw-string extraction, not a real shell parser (see DANGEROUS_COMMAND_PATTERNS
// doc comment for the same caveat).
const RM_MV_COMMAND = /^\s*\b(rm|mv)\s+(.+)/;

// Splits on shell command separators (&&, ||, ;, |) so each segment can be
// checked for a leading rm/mv independently — without this, `RM_MV_COMMAND`'s
// greedy match against the whole string only ever finds the *first* rm/mv in a
// compound command (e.g. `mv a.txt b.txt && rm /etc/passwd`), folding
// everything after it — including a second, independent rm/mv — into the
// first match's argument list instead of examining it as its own command.
// Raw-string splitting, not a real shell parser: doesn't account for
// separators inside quotes, but that's the same accepted tradeoff as the rest
// of this file's command matching.
const COMMAND_SEPARATOR = /&&|\|\||[;|]/;

// Extends the bash denylist: blocks rm/mv where any non-flag argument resolves
// outside workDir and outside the real /tmp/ tree. Checks ALL non-flag args, not
// just the first — for `mv src dest` both matter (dest is where data lands; src
// is being read/removed from outside workDir either way). Checks every
// command segment, not just the first, so a compound command can't hide a
// second rm/mv behind an earlier, innocuous one. Separate from
// findDangerousPattern because it needs workDir to resolve relative paths
// (Section 12).
function findPathEscapingRmMv(command: string, workDir: string): string | null {
  for (const segment of command.split(COMMAND_SEPARATOR)) {
    const match = RM_MV_COMMAND.exec(segment);
    if (!match) continue;
    const [, verb, rest] = match;
    const args = rest.split(/\s+/).filter((arg) => arg.length > 0 && !arg.startsWith('-'));
    for (const target of args) {
      const resolved = resolveInWorkDir(workDir, target);
      if (!isPathAllowed(workDir, resolved)) {
        return `${verb} targeting a path outside the working directory and outside /tmp/ (${target})`;
      }
    }
  }
  return null;
}

const readFileParams = Type.Object({
  path: Type.String({ description: 'File path, absolute or relative to the working directory' }),
});
const writeFileParams = Type.Object({
  path: Type.String({ description: 'File path, absolute or relative to the working directory' }),
  content: Type.String({ description: 'Full file content to write' }),
});
const bashParams = Type.Object({
  command: Type.String({ description: 'Shell command to execute' }),
});
const findSkillParams = Type.Object({
  query: Type.String({ description: 'Search query, e.g. a technology or task name' }),
});
const addSkillParams = Type.Object({
  package: Type.String({ description: 'Skill package to install from, e.g. "vercel-labs/agent-skills"' }),
  skill: Type.String({ description: 'Name of the specific skill within the package to install' }),
});

/**
 * Options for wiring the skill tools into a live agent session.
 * `skillsCliAvailable` gates whether find_skill/add_skill are exposed at all
 * (probed once at session start in agent-session.ts — Rule 8: don't ship tools
 * that are present but always fail).
 * `getSystemPrompt`/`setSystemPrompt` let add_skill mutate the live Agent's
 * system prompt (agent.state.systemPrompt) without agent-tools.ts depending on
 * the Agent class directly.
 */
export interface AgentToolsOptions {
  skillsCliAvailable: boolean;
  getSystemPrompt: () => string;
  setSystemPrompt: (prompt: string) => void;
}

export function createAgentTools(workDir: string, options?: AgentToolsOptions): AgentTool[] {
  const readFileTool: AgentTool<typeof readFileParams> = {
    name: 'read_file',
    label: 'Read File',
    description: 'Read the contents of a file as UTF-8 text.',
    parameters: readFileParams,
    execute: async (_toolCallId: string, params: Static<typeof readFileParams>) => {
      const fullPath = resolveInWorkDir(workDir, params.path);
      // Reads are confined to the same roots as writes. Without this the agent
      // could read anything the operator's account can (~/.ssh/id_rsa,
      // ~/.aws/credentials, proxy_config.toml's default_api_key) — and because
      // this session's model provider is the proxy itself, whatever it reads is
      // sent upstream as conversation context.
      if (!isPathAllowed(workDir, fullPath)) {
        throw new Error(`Blocked: read_file path is outside the working directory and outside /tmp/ (${fullPath}).`);
      }
      const content = await readFile(fullPath, 'utf-8');
      return {
        content: [{ type: 'text' as const, text: content }],
        details: { path: fullPath, bytes: Buffer.byteLength(content) },
      };
    },
  };

  const writeFileTool: AgentTool<typeof writeFileParams> = {
    name: 'write_file',
    label: 'Write File',
    description: 'Write UTF-8 text content to a file, creating parent directories as needed. Overwrites existing files.',
    parameters: writeFileParams,
    execute: async (_toolCallId: string, params: Static<typeof writeFileParams>) => {
      const fullPath = resolveInWorkDir(workDir, params.path);
      if (!isPathAllowed(workDir, fullPath)) {
        throw new Error(`Blocked: write_file path is outside the working directory and outside /tmp/ (${fullPath}).`);
      }
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, params.content, 'utf-8');
      return {
        content: [{ type: 'text' as const, text: `Wrote ${Buffer.byteLength(params.content)} bytes to ${fullPath}` }],
        details: { path: fullPath, bytes: Buffer.byteLength(params.content) },
      };
    },
  };

  const bashTool: AgentTool<typeof bashParams> = {
    name: 'bash',
    label: 'Run Shell Command',
    description: `Run a shell command in the working directory (${workDir}) and return its stdout/stderr. Times out after ${BASH_TIMEOUT_MS / 1000}s.`,
    parameters: bashParams,
    execute: async (_toolCallId: string, params: Static<typeof bashParams>, signal?: AbortSignal) => {
      const blocked = findDangerousPattern(params.command);
      if (blocked) {
        throw new Error(`Blocked: command matches a denylisted pattern (${blocked}). Command: ${params.command}`);
      }
      const pathEscape = findPathEscapingRmMv(params.command, workDir);
      if (pathEscape) {
        throw new Error(`Blocked: ${pathEscape}. Command: ${params.command}`);
      }
      const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolvePromise, rejectPromise) => {
        // execFile's own `error.killed`/`error.signal` only mean "the process
        // ended via a signal" — set the same way whether Node's `timeout`
        // option fired, the child killed itself (e.g. `kill $$`), or something
        // external killed it (OOM killer, a manual SIGKILL) — so neither can be
        // used on its own to tell a real timeout apart from any other signal
        // exit. Track our own timeout instead: a plain flag flipped by a
        // setTimeout matched to the same BASH_TIMEOUT_MS, so the "timed out"
        // message is only reported when this timer — not some other signal —
        // is what ended the command.
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
        }, BASH_TIMEOUT_MS);
        const child = execFile(
          // 'sh' (PATH-resolved) rather than the hardcoded '/bin/sh': execFile
          // calls the OS spawn API directly, bypassing any shell's own path
          // translation, so an absolute POSIX path isn't valid on Windows even
          // under Git Bash — Node fails the spawn (ENOENT) before the command
          // ever runs. Bare 'sh' resolves via PATH on both Unix (always
          // present) and Windows with Git for Windows installed (this file
          // already assumes POSIX shell syntax throughout — see the rm/mv
          // denylist patterns below — so this doesn't add a new dependency).
          'sh',
          ['-c', params.command],
          { cwd: workDir, timeout: BASH_TIMEOUT_MS, maxBuffer: BASH_MAX_BUFFER, signal },
          (error, stdout, stderr) => {
            clearTimeout(timer);
            if (error && timedOut) {
              rejectPromise(new Error(`Command timed out after ${BASH_TIMEOUT_MS / 1000}s: ${params.command}`));
              return;
            }
            const signal = (error as (NodeJS.ErrnoException & { signal?: string }) | null)?.signal;
            if (error && signal) {
              rejectPromise(new Error(`Command was killed by signal ${signal} (not a timeout): ${params.command}`));
              return;
            }
            // A real (nonzero) exit sets error.code to the numeric exit code
            // (matching child.exitCode) — that's a normal outcome the caller
            // must still see via stdout/stderr/exit code, not a rejection. A
            // spawn failure (bad executable, EPERM, missing shell, etc.) sets
            // error.code to an errno *string* (e.g. 'ENOENT') instead, and
            // child.exitCode to a negative libuv errno rather than null —
            // silently resolving that as if it were a real exit code (Rule 8:
            // fail loud) previously reported success with a nonsense code.
            if (error && typeof error.code === 'string') {
              rejectPromise(new Error(`Failed to run command: ${error.message}`));
              return;
            }
            resolvePromise({ stdout, stderr, code: child.exitCode });
          }
        );
      });
      const text = [
        result.stdout && `stdout:\n${result.stdout}`,
        result.stderr && `stderr:\n${result.stderr}`,
        `exit code: ${result.code}`,
      ]
        .filter(Boolean)
        .join('\n\n');
      return {
        content: [{ type: 'text' as const, text }],
        details: result,
      };
    },
  };

  const tools: AgentTool[] = [readFileTool, writeFileTool, bashTool];

  if (options?.skillsCliAvailable) {
    let installedCount = 0;

    const findSkillTool: AgentTool<typeof findSkillParams> = {
      name: 'find_skill',
      label: 'Find Skill',
      description: 'Search for installable agent skill packages matching a query. Read-only — does not install anything.',
      parameters: findSkillParams,
      execute: async (_toolCallId: string, params: Static<typeof findSkillParams>) => {
        const { stdout } = await runCli('npx', ['skills', 'find', params.query, '--json'], workDir, SKILL_TIMEOUT_MS, SKILL_MAX_BUFFER);
        return {
          content: [{ type: 'text' as const, text: stdout || '[]' }],
          details: { query: params.query },
        };
      },
    };

    const addSkillTool: AgentTool<typeof addSkillParams> = {
      name: 'add_skill',
      label: 'Add Skill',
      description: `Install a specific skill from a package found via find_skill, then add its instructions to the running system prompt. Limited to ${MAX_SKILLS} skills per session.`,
      parameters: addSkillParams,
      execute: async (_toolCallId: string, params: Static<typeof addSkillParams>) => {
        if (installedCount >= MAX_SKILLS) {
          throw new Error(`${MAX_SKILLS}-skill limit reached for this session — cannot add "${params.skill}" from "${params.package}".`);
        }

        await runCli(
          'npx',
          ['skills', 'add', params.package, '--skill', params.skill, '--agent', 'pi', '-y', '-p'],
          workDir,
          SKILL_TIMEOUT_MS,
          SKILL_MAX_BUFFER,
        );

        // `skills add --agent pi -p` writes SKILL.md files under `.pi/skills` relative
        // to the project root (confirmed by reading vercel-labs/skills' own agent
        // registry: skillsDir: ".pi/skills" for the "pi" agent target, project-scoped).
        const skillsDir = resolve(workDir, '.pi/skills');
        const env = new NodeExecutionEnv({ cwd: workDir });
        const { skills, diagnostics } = await loadSkills(env, skillsDir);
        const added = skills.find((s) => s.name === params.skill);
        if (!added) {
          const diagText = diagnostics.map((d) => `${d.code}: ${d.message} (${d.path})`).join('; ');
          throw new Error(
            `"skills add" reported success but skill "${params.skill}" was not found under ${skillsDir}.${diagText ? ` Diagnostics: ${diagText}` : ''}`,
          );
        }

        const formatted = formatSkillInvocation(added);
        options.setSystemPrompt(`${options.getSystemPrompt()}\n\n${formatted}`);
        installedCount += 1;

        return {
          content: [{ type: 'text' as const, text: `Added skill "${added.name}" (${installedCount}/${MAX_SKILLS} used).` }],
          details: { name: added.name, filePath: added.filePath, installedCount },
        };
      },
    };

    tools.push(findSkillTool, addSkillTool);
  }

  return tools;
}
