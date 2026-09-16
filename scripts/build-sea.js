#!/usr/bin/env node

/**
 * Builds a single-file executable of the Node server (src/server.ts) using
 * Node's built-in SEA (Single Executable Application) support.
 *
 * This is an ADDITIONAL distribution channel, not a replacement for anything:
 *   - `npm run build`  -> tsc -p tsconfig.server.json -> dist/*.js + node_modules
 *                         (what the Dockerfile ships: `node dist/server.js`)
 *   - `npm run build:native` (this script) -> dist/<name> single binary
 *
 * HOW SEA WORKS: SEA takes exactly ONE JavaScript file — it does not walk
 * node_modules at all. So the flow is:
 *
 *   1. esbuild bundles src/server.ts + the entire dependency graph into one
 *      file. esbuild strips TypeScript types and resolves ESM/exports maps
 *      natively, so no separate `tsc` pass is needed for the bundle.
 *   2. `node --experimental-sea-config` turns that bundle into a blob.
 *   3. The host Node binary is copied, and postject injects the blob into it.
 *   4. On macOS the copied binary must be re-signed, since injecting a
 *      section invalidates the existing signature.
 *
 * NOTE ON TYPES: esbuild only strips types, it does not check them. This
 * script runs `tsc --noEmit -p tsconfig.server.json` first so that a native
 * build cannot silently ship code that `npm run build` would have rejected.
 *
 * CROSS-COMPILATION: SEA cannot cross-compile — the produced binary is for
 * the platform/arch of the Node that built it, because it IS a copy of that
 * Node binary. Building all targets requires running this on each platform
 * (e.g. in CI).
 *
 * BUILD NODE REQUIREMENTS: the Node running this script is the runtime that
 * ends up embedded in the output, so it should satisfy this package's
 * "engines" field. It must also be an official, self-contained build — step 3
 * copies this very binary and patches it, so a thin launcher linked against a
 * shared libnode cannot work. Homebrew ships node as a ~67KB stub +
 * libnode.dylib; the fuse lives in the dylib, so injection fails. An official
 * build (nodejs.org or nvm) is ~110MB. Check by size; neither
 * `node --experimental-sea-config /dev/null` nor
 * process.config.variables.node_use_node_snapshot distinguishes the two — the
 * former only validates config parsing and passes on the unusable stub.
 *
 * SENTINEL FUSE: --sentinel-fuse must be passed explicitly, read from the
 * binary at build time. See readSentinelFuse below for why assuming
 * postject's default (or any hardcoded value) breaks.
 *
 * WHAT IS NOT IN THE BINARY (see EXTERNALS below): two optional integrations
 * are deliberately excluded. Both already fail soft at runtime today, and both
 * are already absent from the Docker image, so the binary matches the
 * container's supported feature set rather than inventing a third one.
 */
import { execFileSync } from 'child_process';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const BUILD = path.join(ROOT, '.sea-build');

/**
 * Modules left OUT of the bundle, marked --external for esbuild.
 *
 * esbuild would fail the build on these rather than skip them: it cannot
 * resolve either specifier statically, and an unresolvable import is an error,
 * not a warning. Marking them external turns each into a plain runtime
 * `require()` that throws where the source already handles a throw.
 *
 * @github/keytar — a native .node addon, so SEA (one embedded JS blob, no
 *   mechanism for shipping native addons) could never carry it. src/utils/
 *   key-store.ts already loads it through a non-literal specifier and converts
 *   absence into a KeyStoreError, and Dockerfile:20 already installs with
 *   --omit=optional. So in the binary, as in Docker, `store_key_in_system =
 *   true` fails loud with an actionable message — EXCEPT on win32: keytar needs
 *   too many dependencies there (Visual Studio Build Tools with the C++ workload
 *   + Python 3, via node-gyp) to be worth carrying into a single-file
 *   distribution, so loadKeytar falls back to src/utils/body-key-store.ts,
 *   which stores the keys in the executable's own file body (plaintext; see
 *   that file's header). macOS and Linux keep keytar and the OS keychain;
 *   macOS/Linux SEA binaries keep the fatal KeyStoreError.
 *
 * chatjimmy — the sdk:// route's optional submodule
 *   (src/utils/sdk-handler.ts:62-75). It is loaded via a deliberately
 *   non-literal relative specifier ('../../submodules/chatjimmy/dist/index.js')
 *   so it is not a static build/typecheck dependency. Bundling it would mean
 *   making that import literal, which would turn an optional submodule into a
 *   hard build prerequisite for every native build. Excluded instead: the
 *   existing catch reports "ChatJimmy SDK not available" and only sdk:// URLs
 *   are affected.
 *
 * CAVEAT on the chatjimmy exclusion: that specifier is relative to the SOURCE
 * file's location, and in the binary there is no source tree for it to be
 * relative to — so the import fails regardless of what sits next to the
 * executable. sdk:// routes are unsupported in the native binary, full stop.
 * That is a real functional difference from `node dist/server.js`, which
 * resolves the submodule when it is present and built. It is called out in the
 * build banner below and should stay in the README alongside the
 * no-cross-compile note.
 */
const EXTERNALS = ['@github/keytar', '../../submodules/chatjimmy/dist/index.js'];

/** Platform-tagged output name, so CI can collect one artifact per runner. */
function outputName() {
  const platform = os.platform();
  const arch = os.arch();
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'model-proxy-v3-macos-arm64' : 'model-proxy-v3-macos-x64';
  }
  if (platform === 'linux') {
    return arch === 'arm64' ? 'model-proxy-v3-linux-arm64' : 'model-proxy-v3-linux-x64';
  }
  if (platform === 'win32') return 'model-proxy-v3-win.exe';
  throw new Error(`Unsupported platform: ${platform}`);
}

/**
 * Quotes one shell word (the command or one of its arguments) for cmd.exe.
 *
 * With shell:true, execFileSync joins the command and argv with plain spaces
 * and does NOT escape anything itself, so cmd re-splits every word on
 * whitespace before the child ever sees it. The esbuild banner
 * ('--banner:js=const X = ...') is the first casualty: cmd hands esbuild the
 * fragments as separate positional arguments, and esbuild reads the extra ones
 * as additional entry points ("Must use outdir when there are multiple input
 * files"). The command is just as exposed — process.execPath is
 * 'C:\\Program Files\\nodejs\\node.exe', which cmd truncates to 'C:\\Program'
 * ("is not recognized as an internal or external command") — and so is any
 * path under a directory whose name contains a space.
 *
 * Wrapping such a word in double quotes keeps it whole: cmd strips the quotes
 * and passes the inner text — including the single quotes the banner's
 * `require('node:url')` needs — through untouched. Words with no
 * shell-significant characters are left bare, which also keeps paths that end
 * in a backslash safe (a quoted '...\' would let the child's argv parser read
 * the closing quote as escaped and swallow it).
 *
 * A literal double quote cannot be represented inside a double-quoted word in
 * a way that survives both cmd and the child's argv parsing, so rather than
 * emit something subtly wrong we fail loud. No word in this script contains
 * one.
 */
function quoteForCmd(word) {
  if (!/[ \t&|<>^()]/.test(word)) return word;
  if (word.includes('"')) {
    throw new Error(`Cannot quote build word containing a double quote: ${word}`);
  }
  return `"${word}"`;
}

/**
 * shell:true on Windows because `npx` there is `npx.cmd`, a batch script.
 * execFileSync spawns the executable directly with no shell, and CreateProcess
 * cannot run a .cmd — so every npx step below dies with ENOENT without it.
 * (Node 20+ additionally refuses to run .cmd/.bat via execFile without a
 * shell, as a fix for CVE-2024-27980.)
 *
 * The shell is confined to Windows: on POSIX it is unnecessary, and it would
 * put an extra layer of quoting between us and the argv we pass. On Windows it
 * has exactly that cost, so the command and every argument are run through
 * quoteForCmd. Every word here is build-time constant or a path this script
 * computed, so there is no untrusted input to interpolate either way.
 */
function run(cmd, args, opts = {}) {
  const useShell = os.platform() === 'win32';
  execFileSync(useShell ? quoteForCmd(cmd) : cmd, useShell ? args.map(quoteForCmd) : args, {
    stdio: 'inherit',
    cwd: ROOT,
    shell: useShell,
    ...opts,
  });
}

/**
 * Reads the SEA sentinel fuse out of a Node binary.
 *
 * The fuse is the marker postject overwrites to record that a blob was
 * injected, and it must match byte for byte or injection fails. Its exact
 * spelling is not stable: it has appeared as both "NODE_SEA_FUSE_<hash>" and
 * "POSTJECT_SENTINEL_<hash>", with a hash that changes between Node releases.
 * Both prefixes are therefore tried, and the value is taken from the binary
 * being injected rather than assumed from postject's default (postject
 * 1.0.0-alpha.6 defaults to a fixed POSTJECT_SENTINEL_ hash that recent Node
 * builds do not carry). Pinning a hash here would just move the breakage to
 * the next Node upgrade.
 *
 * The file is ~110MB, so it is scanned in chunks with a small overlap between
 * them (a fuse straddling a chunk boundary would otherwise be missed).
 * 'latin1' maps bytes 1:1 to code units, so byte offsets and string indices
 * stay aligned.
 *
 * @param {string} binaryPath
 * @returns {string} the full fuse string
 */
function readSentinelFuse(binaryPath) {
  const PATTERN = /(?:NODE_SEA_FUSE|POSTJECT_SENTINEL)_[0-9a-f]{32}/;
  const CHUNK = 8 * 1024 * 1024;
  // Longest possible match; overlap by this much so a fuse split across two
  // reads is still seen whole in the second one.
  const OVERLAP = 64;

  const fd = openSync(binaryPath, 'r');
  try {
    const size = statSync(binaryPath).size;
    const buf = Buffer.alloc(CHUNK);
    let pos = 0;
    let carry = '';
    while (pos < size) {
      const bytes = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (bytes <= 0) break;
      const text = carry + buf.subarray(0, bytes).toString('latin1');
      const match = PATTERN.exec(text);
      if (match) return match[0];
      carry = text.slice(-OVERLAP);
      pos += bytes;
    }
  } finally {
    closeSync(fd);
  }

  throw new Error(
    `No SEA sentinel fuse found in ${binaryPath}.\n` +
      'Expected a NODE_SEA_FUSE_<hash> or POSTJECT_SENTINEL_<hash> marker. This usually means\n' +
      'the build Node lacks SEA support, or is a thin launcher linked against a shared libnode\n' +
      '(Homebrew builds node as a ~67KB stub + libnode.dylib; the fuse lives in the dylib and\n' +
      'cannot be injected). Use an official self-contained Node (nodejs.org or nvm) instead —\n' +
      'a real one is ~110MB.'
  );
}

function main() {
  // --- 0. Typecheck ------------------------------------------------------
  //
  // esbuild strips types without checking them, so without this a native build
  // could ship code that `npm run build` (tsc) would have rejected. Run first,
  // before anything is removed or written, so a failure costs nothing and
  // leaves the previous dist/ intact.
  console.error('[build-sea] typechecking...');
  run('npx', ['tsc', '--noEmit', '-p', 'tsconfig.server.json']);

  rmSync(BUILD, { recursive: true, force: true });
  mkdirSync(BUILD, { recursive: true });
  mkdirSync(DIST, { recursive: true });

  const bundlePath = path.join(BUILD, 'bundle.js');

  // --- 1. Bundle ---------------------------------------------------------
  //
  // format=cjs because SEA's default loader treats the blob as CommonJS.
  // esbuild converts the ESM+TS sources to CJS as part of bundling, doing the
  // whole graph at once with correct ESM semantics.
  //
  // Every dependency is pulled into the output (the default for a
  // non-external build), which is what SEA needs — there is no node_modules
  // beside the finished binary. js-tiktoken's rank tables are statically
  // imported in src/utils/token-counting.ts, so they inline here rather than
  // being read from disk at runtime.
  //
  // --define:import.meta.url is required, not cosmetic. Bundling ESM to CJS
  // leaves `import.meta` with no CJS equivalent, and esbuild's fallback is to
  // emit `import_meta = {}` — so `import.meta.url` becomes undefined. Any
  // dependency doing `createRequire(import.meta.url)` at MODULE SCOPE then
  // throws ERR_INVALID_ARG_VALUE the instant its module initializer runs,
  // taking the process down.
  //
  // @earendil-works/pi-tui/dist/native-modifiers.js does exactly this (and
  // terminal.js alongside it), so `TUI=1` crashed the binary at startup even
  // though plain HTTP serving was fine — the TUI import is lazy, so nothing
  // touched that initializer until the TUI path was actually taken.
  //
  // Defining it as a file:// URL under the executable's own directory gives
  // createRequire a valid absolute base. What it resolves to barely matters:
  // pi-tui only uses cjsRequire to probe for an optional native .node addon
  // (darwin-modifiers.node) inside a try/catch, and SEA cannot ship native
  // addons anyway — so every candidate path misses and it returns undefined,
  // which is the same already-supported outcome as running on an unsupported
  // platform. The point is that it MISSES rather than THROWS.
  console.error('[build-sea] bundling with esbuild...');
  run('npx', [
    'esbuild',
    'src/server.ts',
    '--bundle',
    '--platform=node',
    '--target=node22',
    '--format=cjs',
    '--loader:.json=json',
    '--define:import.meta.url=__SEA_IMPORT_META_URL__',
    "--banner:js=const __SEA_IMPORT_META_URL__ = require('node:url').pathToFileURL(process.execPath).href;",
    ...EXTERNALS.map((m) => `--external:${m}`),
    `--outfile=${bundlePath}`,
  ]);

  // --- 2. SEA blob -------------------------------------------------------
  const seaConfigPath = path.join(BUILD, 'sea-config.json');
  const blobPath = path.join(BUILD, 'sea-prep.blob');
  writeFileSync(
    seaConfigPath,
    JSON.stringify(
      {
        main: bundlePath,
        output: blobPath,
        // The bundle is already a single self-contained CJS file, so SEA's
        // own snapshot support isn't needed.
        disableExperimentalSEAWarning: true,
      },
      null,
      2
    ) + '\n'
  );

  console.error('[build-sea] generating SEA blob...');
  run(process.execPath, ['--experimental-sea-config', seaConfigPath]);

  // --- 3. Inject into a copy of the host Node binary ---------------------
  const outPath = path.join(DIST, outputName());
  // Remove any previous build first: postject rewrites the file in place, and
  // re-injecting into an already-injected binary appends a second section
  // rather than replacing the first.
  rmSync(outPath, { force: true });
  copyFileSync(process.execPath, outPath);
  // copyFileSync preserves the source mode, and an installed node binary is
  // typically r-xr-xr-x — postject needs to open it read-write ("Can't read
  // and write to target executable" otherwise).
  chmodSync(outPath, 0o755);

  // macOS: strip the existing signature before injecting. Injecting a section
  // invalidates any existing signature anyway, and codesign refuses to re-sign
  // over a stale one. Order matters: remove -> inject -> re-sign.
  if (os.platform() === 'darwin') {
    try {
      run('codesign', ['--remove-signature', outPath]);
    } catch {
      // Unsigned binary (or codesign unavailable) — nothing to remove.
    }
  }

  const fuse = readSentinelFuse(outPath);
  console.error(`[build-sea] injecting blob with postject (fuse: ${fuse})...`);
  const postjectArgs = ['postject', outPath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', fuse];
  // Mach-O needs the segment name; ELF and PE do not.
  if (os.platform() === 'darwin') {
    postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  }
  run('npx', postjectArgs);

  // --- 4. Re-sign (macOS) ------------------------------------------------
  if (os.platform() === 'darwin') {
    console.error('[build-sea] re-signing...');
    run('codesign', ['--sign', '-', outPath]);
  }

  console.error(`[build-sea] built ${outPath}`);
  console.error(
    '[build-sea] note: proxy_config.toml is still read from the working directory at\n' +
      '            runtime (PROXY_CONFIG_PATH, default ./proxy_config.toml) — it is not\n' +
      '            embedded in the binary.\n' +
      '[build-sea] excluded from this binary: system keychain (@github/keytar) and\n' +
      '            sdk:// routes (chatjimmy). sdk:// always fails loud, as in the\n' +
      '            Docker image. keytar needs too many dependencies on Windows, so the\n' +
      '            win32 build substitutes an in-binary body store for\n' +
      '            store_key_in_system (plaintext in the .exe, needs a writable\n' +
      '            directory); macOS/Linux SEA binaries keep the fatal KeyStoreError,\n' +
      '            and a `node dist/server.js` run on those platforms keeps keytar.'
  );
}

main();
