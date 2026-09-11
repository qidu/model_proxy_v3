import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createAgentTools } from '../../src/agent-tools.js';

/**
 * Unit tests for the hand-authored AGENT=true tools: read_file/write_file/bash,
 * with a focus on the two safety mechanisms added on top of bash/write_file:
 *  - Section 11: DANGEROUS_COMMAND_PATTERNS / findDangerousPattern (bash denylist)
 *  - Section 12: isPathAllowed / findPathEscapingRmMv (workDir + /tmp/ confinement)
 * Assertions check real side effects (file created/not created, content, error
 * identity) rather than just "did not throw" / "threw something".
 */

// "Outside" location for negative tests: outside workDir AND outside /tmp/ — a
// scratch dir under this repo's own tests/unit, neither allowed root.
const OUTSIDE_ROOT = resolve('tests/unit/.agent-tools-outside-scratch');

// fs.symlinkSync requires elevated privileges (or Developer Mode) to create
// symlinks as a regular user on Windows — unlike Unix, where any user can
// `ln -s`. Probed once at module load (create+delete a throwaway symlink) so
// the symlink-escape tests below can skip cleanly with a clear reason on a
// machine without that privilege, instead of failing on an unrelated EPERM.
const CAN_SYMLINK = (() => {
  const probeDir = mkdtempSync(join(tmpdir(), 'agent-tools-symlink-probe-'));
  const target = join(probeDir, 'target');
  const link = join(probeDir, 'link');
  writeFileSync(target, '');
  try {
    symlinkSync(target, link);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
})();

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'agent-tools-test-'));
  mkdirSync(OUTSIDE_ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(OUTSIDE_ROOT, { recursive: true, force: true });
});

function getTool(tools: ReturnType<typeof createAgentTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `expected a tool named "${name}"`);
  return tool!;
}

describe('createAgentTools — tool list', () => {
  it('exposes read_file/write_file/bash by default, no skill tools', () => {
    const tools = createAgentTools(workDir);
    assert.deepEqual(
      tools.map((t) => t.name),
      ['read_file', 'write_file', 'bash'],
    );
  });

  it('adds find_skill/add_skill only when skillsCliAvailable is true', () => {
    const tools = createAgentTools(workDir, {
      skillsCliAvailable: true,
      getSystemPrompt: () => '',
      setSystemPrompt: () => {},
    });
    assert.deepEqual(
      tools.map((t) => t.name),
      ['read_file', 'write_file', 'bash', 'find_skill', 'add_skill'],
    );
  });
});

describe('read_file', () => {
  it('reads a file relative to workDir and reports its resolved path/size', async () => {
    writeFileSync(join(workDir, 'note.txt'), 'hello world');
    const tools = createAgentTools(workDir);
    const readFileTool = getTool(tools, 'read_file');

    const result = await readFileTool.execute('t1', { path: 'note.txt' });

    assert.equal(result.content[0].text, 'hello world');
    assert.equal(result.details.path, join(workDir, 'note.txt'));
    assert.equal(result.details.bytes, Buffer.byteLength('hello world'));
  });

  it('rejects when the file does not exist', async () => {
    const tools = createAgentTools(workDir);
    const readFileTool = getTool(tools, 'read_file');
    await assert.rejects(() => readFileTool.execute('t1', { path: 'missing.txt' }));
  });

  // read_file previously had no path check at all (write_file did), letting the
  // agent read ~/.ssh/id_rsa, ~/.aws/credentials, or proxy_config.toml's
  // default_api_key — and since this session's provider is the proxy itself,
  // anything read is sent upstream as context.
  it('blocks reads outside workDir and outside /tmp/', async () => {
    const tools = createAgentTools(workDir);
    const readFileTool = getTool(tools, 'read_file');
    const target = join(OUTSIDE_ROOT, 'secret.txt');
    writeFileSync(target, 'SECRET');

    await assert.rejects(
      () => readFileTool.execute('t1', { path: target }),
      /read_file path is outside the working directory and outside \/tmp\//,
    );
  });

  it('blocks a read that escapes via a symlink inside workDir', async (t) => {
    if (!CAN_SYMLINK) {
      t.skip('symlink creation not permitted on this machine (needs admin or Developer Mode on Windows)');
      return;
    }
    const tools = createAgentTools(workDir);
    const readFileTool = getTool(tools, 'read_file');
    const secret = join(OUTSIDE_ROOT, 'secret.txt');
    writeFileSync(secret, 'SECRET');
    symlinkSync(secret, join(workDir, 'innocent.txt'));

    await assert.rejects(
      () => readFileTool.execute('t1', { path: 'innocent.txt' }),
      /read_file path is outside the working directory and outside \/tmp\//,
    );
  });
});

describe('write_file', () => {
  it('writes content relative to workDir, creating parent dirs', async () => {
    const tools = createAgentTools(workDir);
    const writeFileTool = getTool(tools, 'write_file');

    const result = await writeFileTool.execute('t1', { path: 'nested/dir/out.txt', content: 'payload' });

    const fullPath = join(workDir, 'nested/dir/out.txt');
    assert.equal(existsSync(fullPath), true);
    assert.equal(readFileSync(fullPath, 'utf-8'), 'payload');
    assert.equal(result.details.path, fullPath);
    assert.equal(result.details.bytes, Buffer.byteLength('payload'));
  });

  it('allows writing under the real /tmp/ tree even when workDir is elsewhere', async () => {
    const tools = createAgentTools(workDir);
    const writeFileTool = getTool(tools, 'write_file');
    const target = join(tmpdir(), `agent-tools-test-allowed-${process.pid}.txt`);

    try {
      await writeFileTool.execute('t1', { path: target, content: 'ok' });
      assert.equal(existsSync(target), true);
      assert.equal(readFileSync(target, 'utf-8'), 'ok');
    } finally {
      rmSync(target, { force: true });
    }
  });

  it('blocks writes outside workDir and outside /tmp/, and does not create the file', async () => {
    const tools = createAgentTools(workDir);
    const writeFileTool = getTool(tools, 'write_file');
    const target = join(OUTSIDE_ROOT, 'should-not-exist.txt');

    await assert.rejects(
      () => writeFileTool.execute('t1', { path: target, content: 'x' }),
      /outside the working directory and outside \/tmp\//,
    );
    assert.equal(existsSync(target), false);
  });

  // isPathAllowed used to be purely lexical, so a symlink *inside* workDir
  // pointing outside it passed the check and the write followed the link —
  // reporting success on an in-scope path while clobbering a file outside both
  // allowed roots. The agent can plant that symlink itself (`ln -s` is on no
  // denylist), making it a self-contained bypass of the whole confinement.
  it('blocks a write that escapes via a symlinked file inside workDir, leaving the target intact', async (t) => {
    if (!CAN_SYMLINK) {
      t.skip('symlink creation not permitted on this machine (needs admin or Developer Mode on Windows)');
      return;
    }
    const tools = createAgentTools(workDir);
    const writeFileTool = getTool(tools, 'write_file');
    const outsideTarget = join(OUTSIDE_ROOT, 'protected.txt');
    writeFileSync(outsideTarget, 'ORIGINAL');
    symlinkSync(outsideTarget, join(workDir, 'innocent.txt'));

    await assert.rejects(
      () => writeFileTool.execute('t1', { path: 'innocent.txt', content: 'PWNED' }),
      /outside the working directory and outside \/tmp\//,
    );
    assert.equal(readFileSync(outsideTarget, 'utf-8'), 'ORIGINAL', 'symlink target must not be overwritten');
  });

  it('blocks a write through a symlinked parent directory inside workDir', async (t) => {
    if (!CAN_SYMLINK) {
      t.skip('symlink creation not permitted on this machine (needs admin or Developer Mode on Windows)');
      return;
    }
    const tools = createAgentTools(workDir);
    const writeFileTool = getTool(tools, 'write_file');
    // The leaf doesn't exist yet (the usual write_file case) — the escape is
    // the symlinked *directory* in the middle of the path, which realpath
    // resolution must still catch.
    symlinkSync(OUTSIDE_ROOT, join(workDir, 'linkdir'));

    await assert.rejects(
      () => writeFileTool.execute('t1', { path: 'linkdir/new-file.txt', content: 'x' }),
      /outside the working directory and outside \/tmp\//,
    );
    assert.equal(existsSync(join(OUTSIDE_ROOT, 'new-file.txt')), false);
  });

  it('still allows a normal write to a not-yet-existing nested path', async () => {
    const tools = createAgentTools(workDir);
    const writeFileTool = getTool(tools, 'write_file');

    await writeFileTool.execute('t1', { path: 'deep/nested/new.txt', content: 'ok' });

    assert.equal(readFileSync(join(workDir, 'deep/nested/new.txt'), 'utf-8'), 'ok');
  });
});

describe('bash — normal execution', () => {
  it('runs a safe command in workDir and returns stdout/exit code', async () => {
    const tools = createAgentTools(workDir);
    const bashTool = getTool(tools, 'bash');
    writeFileSync(join(workDir, 'a.txt'), '');
    writeFileSync(join(workDir, 'b.txt'), '');

    const result = await bashTool.execute('t1', { command: 'ls' });

    assert.equal(result.details.code, 0);
    assert.match(result.details.stdout, /a\.txt/);
    assert.match(result.details.stdout, /b\.txt/);
  });

  it('does not false-positive on everyday commands', async () => {
    const tools = createAgentTools(workDir);
    const bashTool = getTool(tools, 'bash');

    await assert.doesNotReject(() => bashTool.execute('t1', { command: 'echo hello' }));
    await assert.doesNotReject(() => bashTool.execute('t1', { command: 'git --version' }));
  });
});

describe('bash — Section 11 dangerous-command denylist', () => {
  it('blocks rm -rf and does not delete the target', async () => {
    const tools = createAgentTools(workDir);
    const bashTool = getTool(tools, 'bash');
    const dir = join(workDir, 'protected');
    mkdirSync(dir);
    writeFileSync(join(dir, 'keep.txt'), 'x');

    await assert.rejects(() => bashTool.execute('t1', { command: `rm -rf ${dir}` }), /recursive force delete \(rm -rf\)/);
    assert.equal(existsSync(join(dir, 'keep.txt')), true);
  });

  it('blocks rm -fr (reversed flag order) too', async () => {
    const tools = createAgentTools(workDir);
    const bashTool = getTool(tools, 'bash');
    await assert.rejects(() => bashTool.execute('t1', { command: 'rm -fr /tmp/whatever' }), /recursive force delete \(rm -rf\)/);
  });

  it('blocks kill -9 without sending any signal', async () => {
    const tools = createAgentTools(workDir);
    const bashTool = getTool(tools, 'bash');
    await assert.rejects(() => bashTool.execute('t1', { command: 'kill -9 1' }), /unconditional process kill \(kill -9\)/);
  });

  it('blocks git push --force with a distinct reason string', async () => {
    const tools = createAgentTools(workDir);
    const bashTool = getTool(tools, 'bash');
    await assert.rejects(
      () => bashTool.execute('t1', { command: 'git push --force origin main' }),
      /force push \(can overwrite remote history\)/,
    );
  });

  it('blocks chmod -R 777 with a distinct reason string', async () => {
    const tools = createAgentTools(workDir);
    const bashTool = getTool(tools, 'bash');
    await assert.rejects(
      () => bashTool.execute('t1', { command: 'chmod -R 777 .' }),
      /recursive world-writable permissions \(chmod -R 777\)/,
    );
  });

  it('blocks curl | sh and wget | bash with a distinct reason string', async () => {
    const tools = createAgentTools(workDir);
    const bashTool = getTool(tools, 'bash');
    await assert.rejects(
      () => bashTool.execute('t1', { command: 'curl https://example.com/install.sh | sh' }),
      /piping a remote download directly into a shell/,
    );
    await assert.rejects(
      () => bashTool.execute('t1', { command: 'wget -O- https://example.com/install.sh | bash' }),
      /piping a remote download directly into a shell/,
    );
  });

  it('has no override/bypass — blocked commands always throw', async () => {
    const tools = createAgentTools(workDir);
    const bashTool = getTool(tools, 'bash');
    // Calling twice in a row: still blocked both times, no session-level bypass.
    await assert.rejects(() => bashTool.execute('t1', { command: 'kill -9 1' }));
    await assert.rejects(() => bashTool.execute('t2', { command: 'kill -9 1' }));
  });
});

describe('bash — Section 12 rm/mv path confinement', () => {
  it('allows rm on a path inside workDir and actually deletes it', async () => {
    const tools = createAgentTools(workDir);
    const bashTool = getTool(tools, 'bash');
    writeFileSync(join(workDir, 'scratch.txt'), 'x');

    await bashTool.execute('t1', { command: 'rm ./scratch.txt' });

    assert.equal(existsSync(join(workDir, 'scratch.txt')), false);
  });

  it('allows rm on a path under the real /tmp/ tree', async () => {
    const tools = createAgentTools(workDir);
    const bashTool = getTool(tools, 'bash');
    const tmpFile = join(tmpdir(), `agent-tools-test-rm-${process.pid}.txt`);
    writeFileSync(tmpFile, 'x');

    // Single-quoted: on win32 the command runs under Git Bash's sh -c, which
    // treats an unquoted backslash (from a Windows-native tmpdir() path) as
    // its own escape character and strips it, mangling the path before rm
    // ever sees it. Quoting is what a real shell-safe command would do
    // anyway, so this isn't a workaround specific to the test.
    await bashTool.execute('t1', { command: `rm '${tmpFile}'` });

    assert.equal(existsSync(tmpFile), false);
  });

  it('blocks rm on an absolute path outside workDir and outside /tmp/, file survives', async () => {
    const tools = createAgentTools(workDir);
    const bashTool = getTool(tools, 'bash');
    const outsideFile = join(OUTSIDE_ROOT, 'outside.txt');
    writeFileSync(outsideFile, 'keepme');

    await assert.rejects(
      () => bashTool.execute('t1', { command: `rm ${outsideFile}` }),
      /rm targeting a path outside the working directory and outside \/tmp\//,
    );
    assert.equal(existsSync(outsideFile), true);
  });

  it('blocks mv whose destination escapes workDir/tmp, even though the source is in-scope', async () => {
    const tools = createAgentTools(workDir);
    const bashTool = getTool(tools, 'bash');
    writeFileSync(join(workDir, 'config.toml'), 'stuff');
    const dest = join(OUTSIDE_ROOT, 'config-should-not-move.toml');

    await assert.rejects(
      () => bashTool.execute('t1', { command: `mv config.toml ${dest}` }),
      /mv targeting a path outside the working directory and outside \/tmp\//,
    );
    assert.equal(existsSync(join(workDir, 'config.toml')), true, 'source must not be moved');
    assert.equal(existsSync(dest), false, 'destination must not be created');
  });

  it('blocks mv whose source escapes workDir/tmp, even though the destination is in-scope', async () => {
    const tools = createAgentTools(workDir);
    const bashTool = getTool(tools, 'bash');
    const src = join(OUTSIDE_ROOT, 'outside-src.txt');
    writeFileSync(src, 'x');

    await assert.rejects(
      () => bashTool.execute('t1', { command: `mv ${src} inside-dest.txt` }),
      /mv targeting a path outside the working directory and outside \/tmp\//,
    );
    assert.equal(existsSync(src), true);
    assert.equal(existsSync(join(workDir, 'inside-dest.txt')), false);
  });

  it('allows mv when both source and destination are inside workDir', async () => {
    const tools = createAgentTools(workDir);
    const bashTool = getTool(tools, 'bash');
    writeFileSync(join(workDir, 'from.txt'), 'moved content');

    await bashTool.execute('t1', { command: 'mv from.txt to.txt' });

    assert.equal(existsSync(join(workDir, 'from.txt')), false);
    assert.equal(readFileSync(join(workDir, 'to.txt'), 'utf-8'), 'moved content');
  });

  // A compound command's second rm/mv used to be swallowed as trailing
  // "arguments" of the first (RM_MV_COMMAND's greedy match only ever found
  // one verb per command string) — these prove each `&&`/`;`/`|`-separated
  // segment is now checked independently, so a second, unrelated rm/mv can't
  // hide behind an earlier in-scope one.
  it('blocks a second, unrelated rm hidden after an in-scope command via &&', async () => {
    const tools = createAgentTools(workDir);
    const bashTool = getTool(tools, 'bash');
    writeFileSync(join(workDir, 'kept.txt'), 'x');
    const outsideFile = join(OUTSIDE_ROOT, 'outside.txt');
    writeFileSync(outsideFile, 'keepme');

    await assert.rejects(
      () => bashTool.execute('t1', { command: `echo hi && rm ${outsideFile}` }),
      /rm targeting a path outside the working directory and outside \/tmp\//,
    );
    assert.equal(existsSync(outsideFile), true);
  });

  it('blocks a second, unrelated mv hidden after an in-scope rm via ;', async () => {
    const tools = createAgentTools(workDir);
    const bashTool = getTool(tools, 'bash');
    writeFileSync(join(workDir, 'scratch.txt'), 'x');
    const dest = join(OUTSIDE_ROOT, 'config-should-not-move.toml');
    writeFileSync(join(workDir, 'config.toml'), 'stuff');

    await assert.rejects(
      () => bashTool.execute('t1', { command: `rm scratch.txt ; mv config.toml ${dest}` }),
      /mv targeting a path outside the working directory and outside \/tmp\//,
    );
    assert.equal(existsSync(join(workDir, 'config.toml')), true, 'source must not be moved');
    assert.equal(existsSync(dest), false, 'destination must not be created');
  });

  it('still allows a compound command where every rm/mv segment stays in scope', async () => {
    const tools = createAgentTools(workDir);
    const bashTool = getTool(tools, 'bash');
    writeFileSync(join(workDir, 'a.txt'), 'x');
    writeFileSync(join(workDir, 'b.txt'), 'y');

    await bashTool.execute('t1', { command: 'rm a.txt && mv b.txt c.txt' });

    assert.equal(existsSync(join(workDir, 'a.txt')), false);
    assert.equal(existsSync(join(workDir, 'b.txt')), false);
    assert.equal(readFileSync(join(workDir, 'c.txt'), 'utf-8'), 'y');
  });
});

// A real 60s-timeout case isn't covered here — BASH_TIMEOUT_MS is a module
// constant, not configurable per-call, so exercising it for real would mean a
// 60s test. The behavior that changed is what happens on a *non*-timeout
// kill, which is fast and meaningful to assert directly.
describe('bash — timeout vs. non-timeout kill', () => {
  it('does not misreport an externally-signaled kill as a timeout', async (t) => {
    // On win32 the shell is Git Bash/MSYS2's sh, which doesn't deliver
    // `kill -TERM $$` as a real POSIX signal Node can observe: execFile's
    // error.signal stays null and error.code comes back as an MSYS2-specific
    // numeric encoding rather than a real exit code, so the command resolves
    // instead of rejecting. This is a platform capability gap in Git Bash's
    // signal emulation, not a bug in the bash tool.
    if (process.platform === 'win32') {
      t.skip('Git Bash/MSYS2 does not surface self-delivered signals to Node on win32');
      return;
    }
    const tools = createAgentTools(workDir);
    const bashTool = getTool(tools, 'bash');

    // Self-delivered SIGTERM well within the 60s timeout window: execFile
    // still reports `killed: true`, so this must be distinguished from an
    // actual timeout by identity of the timer, not by `killed` alone.
    await assert.rejects(
      () => bashTool.execute('t1', { command: 'kill -TERM $$' }),
      (err: Error) => {
        assert.match(err.message, /killed by signal/);
        assert.doesNotMatch(err.message, /timed out/);
        return true;
      },
    );
  });
});
