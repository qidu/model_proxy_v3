/**
 * Context-compression plugin (kompress / `kompress-api-server`).
 *
 * Drops low-importance tokens from outbound LLM request text to reduce upstream
 * token usage and cost. The heavy model runs in a persistent Python sidecar (see
 * `submodules/kompress/README.md`); this module only talks to it over HTTP, so it
 * stays compatible with both the Node server and Cloudflare Workers.
 *
 * Unlike the privacy filter, compression is LOSSY and ONE-DIRECTIONAL: there is
 * nothing to restore on the response side. The plugin is entirely inert unless
 * `KOMPRESS_URL` is set, and it fails OPEN by default (a sidecar outage forwards
 * the original text rather than failing the request) because compression is an
 * optimization, not a correctness boundary.
 *
 * Failing open is not the same as failing silently: every fragment the sidecar
 * did not compress is tallied by reason in {@link CompressResult.uncompressed}
 * and the caller logs it (repo rule #8). The reasons stay short and never carry
 * any of the fragment text, which is user content.
 */

import type { Env } from '../types/shared.js';
import { ClaudeProxyError } from './errors.js';
import { isInternalHost } from './routing.js';
import { consumeResponseText } from './spool-response.js';

/**
 * Above this fraction of non-ASCII codepoints a fragment is treated as
 * non-English and passed through uncompressed. The kompress model is
 * English-only and garbles CJK/non-Latin input.
 */
const CJK_NONASCII_THRESHOLD = 0.2;

export interface KompressConfig {
  url: string;
  endpoints: Set<string>;
  failOpen: boolean;
  timeoutMs: number;
  maxChars: number;
  keepRatio: number;
  minChars: number;
  maxLength: number;
}

/**
 * Read kompress configuration from env. Returns null when disabled (no
 * `KOMPRESS_URL`), so callers can cheaply skip all work.
 */
export function getKompressConfig(env?: Env): KompressConfig | null {
  const url = env?.KOMPRESS_URL?.trim();
  if (!url) return null;

  // Validate the URL is internal-only (localhost / RFC-1918 / link-local)
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`KOMPRESS_URL is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`KOMPRESS_URL must use http or https, got: ${parsed.protocol}`);
  }
  if (!isInternalHost(parsed.hostname)) {
    throw new Error(`KOMPRESS_URL must point to localhost or a private/LAN address, got: ${parsed.hostname}`);
  }

  const endpointsRaw = env?.KOMPRESS_ENDPOINTS?.trim() || '/v1/messages,/v1/chat/completions,/v1/responses';
  const endpoints = new Set(
    endpointsRaw
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean),
  );

  // Fail-open by default (inverse of the privacy filter): true unless explicitly disabled.
  const failOpen = env?.KOMPRESS_FAIL_OPEN !== 'false' && env?.KOMPRESS_FAIL_OPEN !== '0';

  const timeoutParsed = Number(env?.KOMPRESS_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutParsed) && timeoutParsed > 0 ? Math.floor(timeoutParsed) : 40000;

  const maxCharsParsed = Number(env?.KOMPRESS_MAX_CHARS);
  const maxChars = Number.isFinite(maxCharsParsed) && maxCharsParsed > 0 ? Math.floor(maxCharsParsed) : 1024000;

  const keepRatioParsed = Number(env?.KOMPRESS_KEEP_RATIO);
  const keepRatio = Number.isFinite(keepRatioParsed) && keepRatioParsed > 0 && keepRatioParsed <= 1
    ? keepRatioParsed
    : 0.5;

  const minCharsParsed = Number(env?.KOMPRESS_MIN_CHARS);
  const minChars = Number.isFinite(minCharsParsed) && minCharsParsed >= 0 ? Math.floor(minCharsParsed) : 200;

  return {
    url: url.replace(/\/+$/, ''),
    endpoints,
    failOpen,
    timeoutMs,
    maxChars,
    keepRatio,
    minChars,
    maxLength: 2048,
  };
}

/** Whether the given proxy path should be compressed under this config. */
export function shouldCompressPath(config: KompressConfig, path: string): boolean {
  // Match on the path portion, ignoring any query string.
  const bare = path.split('?', 1)[0];
  if (path.startsWith('/v1beta/models/') || path.startsWith('/v1/models/')) {
    return config.endpoints.has('/v1beta/models') || config.endpoints.has('/v1/models');
  }
  return config.endpoints.has(bare);
}

/**
 * True when a fragment is non-ASCII-heavy (CJK / non-Latin) and would be garbled
 * by the English-only model. Such fragments are passed through uncompressed.
 */
export function isCjkHeavy(text: string): boolean {
  if (!text) return false;
  let total = 0;
  let nonAscii = 0;
  for (const ch of text) {
    total++;
    const cp = ch.codePointAt(0)!;
    if (cp > 0x7f) {
      nonAscii++;
      // Any codepoint in a CJK / Hangul / Kana range immediately disqualifies.
      if (
        (cp >= 0x3000 && cp <= 0x303f) || // CJK punctuation
        (cp >= 0x3040 && cp <= 0x30ff) || // Hiragana + Katakana
        (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext-A
        (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
        (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
        (cp >= 0x1100 && cp <= 0x11ff) || // Hangul Jamo
        (cp >= 0xff00 && cp <= 0xffef)    // Fullwidth forms
      ) {
        return true;
      }
    }
  }
  if (total === 0) return false;
  return nonAscii / total > CJK_NONASCII_THRESHOLD;
}

/**
 * A reference to one text fragment inside a request body, with a setter so we
 * can write the compressed version back in place.
 */
interface TextRef {
  get(): string;
  set(value: string): void;
}

/**
 * Collect editable references to the text fragments we are allowed to compress:
 * user-message text and tool definitions/results. The system prompt, assistant
 * messages, JSON schemas, images, and tool-call inputs are intentionally left
 * untouched. Understands the Anthropic Messages shape and the OpenAI chat shape.
 */
function collectCompressibleRefs(body: Record<string, unknown>): TextRef[] {
  const refs: TextRef[] = [];

  const pushTextBlocks = (content: unknown) => {
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      // Anthropic text block and OpenAI {type:'text', text} part.
      if (p.type === 'text' && typeof p.text === 'string') {
        refs.push({ get: () => p.text as string, set: (v) => { p.text = v; } });
      } else if (p.type === 'tool_result') {
        // Anthropic tool_result: content is string | ContentBlock[].
        const tc = p.content;
        if (typeof tc === 'string') {
          refs.push({ get: () => p.content as string, set: (v) => { p.content = v; } });
        } else if (Array.isArray(tc)) {
          pushTextBlocks(tc);
        }
      }
    }
  };

  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;
      const m = msg as Record<string, unknown>;
      const role = m.role;
      if (role === 'user') {
        const content = m.content;
        if (typeof content === 'string') {
          refs.push({ get: () => m.content as string, set: (v) => { m.content = v; } });
        } else {
          pushTextBlocks(content);
        }
      } else if (role === 'tool') {
        // OpenAI tool result message: content is a string.
        if (typeof m.content === 'string') {
          refs.push({ get: () => m.content as string, set: (v) => { m.content = v; } });
        }
      }
    }
  }

  // Tool definitions: only the human-language description, never the JSON schema.
  const tools = body.tools;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (!tool || typeof tool !== 'object') continue;
      const t = tool as Record<string, unknown>;
      // Anthropic: tool.description
      if (typeof t.description === 'string') {
        refs.push({ get: () => t.description as string, set: (v) => { t.description = v; } });
      }
      // OpenAI: tool.function.description
      const fn = t.function;
      if (fn && typeof fn === 'object') {
        const f = fn as Record<string, unknown>;
        if (typeof f.description === 'string') {
          refs.push({ get: () => f.description as string, set: (v) => { f.description = v; } });
        }
      }
    }
  }

  return refs;
}

export interface CompressResult {
  /** Possibly-mutated body (same object reference as input). */
  body: Record<string, unknown>;
  /** Number of fragments actually shortened. */
  fragments: number;
  /** Total characters removed across all fragments. */
  savedChars: number;
  /** Percentage of attempted characters removed. */
  savedPct: number;
  /**
   * Fragments forwarded uncompressed for a reason the operator needs to see, one
   * entry per distinct reason with how many fragments it hit: a sidecar call that
   * failed or an answer that could not be read, and the `maxChars` limit that
   * suppresses a whole batch. Reasons are short, are safe to log, and never
   * include any fragment text.
   *
   * A fragment skipped by design — shorter than `minChars`, or non-English
   * (CJK-heavy) — is *not* tallied here: that is the intended steady state for
   * most requests, and a line per request would bury the entries above. An answer
   * that simply did not shorten the text is not a failure either and is not
   * tallied.
   */
  uncompressed: { reason: string; count: number }[];
}

/** The failure half of a fragment call: no shortened text, and why. */
interface FragmentOutcome {
  compressed: string | null;
  reason: string | null;
}

/** `message` for anything thrown, without assuming it is an `Error`. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Compress a single fragment via the sidecar. Returns the shortened text, or
 * null together with a short reason so the failure is reported rather than
 * swallowed (rule #8). The reason never carries fragment text — the parsed
 * answer is deliberately not echoed, because `JSON.parse` failure messages quote
 * the input they rejected.
 */
async function compressFragment(config: KompressConfig, text: string): Promise<FragmentOutcome> {
  let resp: Response;
  try {
    resp = await fetch(`${config.url}/compress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, keep_ratio: config.keepRatio, max_length: config.maxLength }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    return { compressed: null, reason: `sidecar unreachable: ${messageOf(error)}` };
  }
  if (!resp.ok) {
    // The error body is not read at all — nothing here wants it, and the same is
    // true at every other `!response.ok` site in this repo.
    return { compressed: null, reason: `sidecar returned ${resp.status}` };
  }

  // §5.7: the answer is the compressed fragment — derived from request text — so
  // it is read bounded (`max_response_bytes`, a spill above `threshold_bytes`, the
  // parse charged to §5.9) and *without* the trace stage, the same receive the
  // privacy filter's sidecar uses: this body must never be echoed to a log.
  let answer: string;
  try {
    answer = await consumeResponseText(resp.body, (bodyText) => bodyText);
  } catch (error) {
    // A proxy limit — the response cap, a spill failure, a §5.9 refusal — is not
    // the sidecar being broken, and is named as such so the two can be told apart.
    return {
      compressed: null,
      reason: error instanceof ClaudeProxyError
        ? `proxy limit on the answer read: ${error.message}`
        : `answer read failed: ${messageOf(error)}`,
    };
  }

  let payload: { compressed?: unknown };
  try {
    payload = JSON.parse(answer) as { compressed?: unknown };
  } catch {
    return { compressed: null, reason: 'answer was not JSON' };
  }
  if (typeof payload.compressed !== 'string') {
    return { compressed: null, reason: 'answer carried no "compressed" string' };
  }
  return { compressed: payload.compressed, reason: null };
}

/**
 * Compress compressible text in a request body by calling the sidecar once per
 * fragment (in parallel). Fragments that are too short, non-English, or fail to
 * compress are left untouched, and every failure is tallied in
 * {@link CompressResult.uncompressed} for the caller to log. Fails open by
 * default: a sidecar outage forwards the original text. When `config.failOpen`
 * is false, any fragment failure throws so the request fails fast — carrying the
 * sidecar's own reason, so a proxy limit is not reported as a broken sidecar.
 */
export async function compressBody(
  config: KompressConfig,
  body: Record<string, unknown>,
): Promise<CompressResult> {
  const refs = collectCompressibleRefs(body);
  if (refs.length === 0) return { body, fragments: 0, savedChars: 0, savedPct: 0, uncompressed: [] };

  // Build the worklist: skip tiny and non-English fragments.
  const work: { ref: TextRef; text: string }[] = [];
  for (const ref of refs) {
    const text = ref.get();
    if (text.length < config.minChars) continue;
    if (isCjkHeavy(text)) continue;
    work.push({ ref, text });
  }
  if (work.length === 0) return { body, fragments: 0, savedChars: 0, savedPct: 0, uncompressed: [] };

  const totalChars = work.reduce((sum, w) => sum + w.text.length, 0);
  if (totalChars === 0 || totalChars > config.maxChars) {
    // Over the cap the whole batch is left alone, which used to be a silent
    // no-op hitting exactly the requests where compression matters most.
    return {
      body,
      fragments: 0,
      savedChars: 0,
      savedPct: 0,
      uncompressed: totalChars > config.maxChars
        ? [{ reason: `combined text ${totalChars} chars over maxChars ${config.maxChars}`, count: work.length }]
        : [],
    };
  }

  const outcomes = await Promise.all(work.map((w) => compressFragment(config, w.text)));

  const failures = new Map<string, number>();
  let fragments = 0;
  let savedChars = 0;
  for (let i = 0; i < work.length; i++) {
    const { compressed, reason } = outcomes[i];
    if (compressed === null) {
      const why = reason ?? 'unknown failure';
      if (!config.failOpen) {
        throw new Error(`kompress sidecar unavailable: ${why}`);
      }
      failures.set(why, (failures.get(why) ?? 0) + 1);
      continue; // fail open: leave original
    }
    const original = work[i].text;
    if (compressed.length < original.length) {
      work[i].ref.set(compressed);
      fragments++;
      savedChars += original.length - compressed.length;
    }
  }

  const savedPct = totalChars > 0 ? (savedChars / totalChars) * 100 : 0;
  return {
    body,
    fragments,
    savedChars,
    savedPct,
    uncompressed: [...failures].map(([reason, count]) => ({ reason, count })),
  };
}
