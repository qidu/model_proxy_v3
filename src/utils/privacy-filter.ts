/**
 * Privacy filter plugin (OpenAI Privacy Filter / `opf`).
 *
 * Redacts PII out of outbound LLM request text before it leaves the machine and
 * restores the original values in the response returned to the client.
 *
 * Two modes:
 *  1. `sidecar` (default when `PRIVACY_FILTER_URL` is set): the heavy PII model
 *     runs in a persistent Python sidecar (see `submodules/privacy-filter/serve.py`);
 *     this module only talks to it over HTTP, so it stays compatible with both
 *     the Node server and Cloudflare Workers. The sidecar also runs the
 *     entropy-based hash/API-key scan and emits `⟦HASH:n⟧` sentinels.
 *  2. `local`: a self-contained, in-process hash-only redaction that uses the
 *     TypeScript port of `submodules/privacy-filter/hash_detect.py` (see
 *     `./hash-detect.ts`). Useful when you only need to redact hash-shaped
 *     secrets (API keys, tokens) and want to skip the OPF model entirely.
 *
 * The plugin is entirely inert unless `PRIVACY_FILTER_URL` is set OR
 * `[privacy_filter]` toml is present with `mode = "local"` (and `enabled`
 * not explicitly false).
 *
 * Scope — text only. The following content block types are intentionally
 * skipped (binary/opaque payloads that must not be mangled):
 *   - Anthropic `type:"image"` / `type:"document"` → `source.data` (base64)
 *   - OpenAI `type:"image_url"` → `image_url.url` (URL or data URI)
 *   - Gemini `inlineData` part → `inlineData.data` (base64 media bytes)
 */

import type { Env } from '../types/shared.js';
import { ClaudeProxyError } from './errors.js';
import { isInternalHost } from './routing.js';
import { consumeResponseText } from './spool-response.js';
import {
  buildWhitelist,
  findHashSpans,
  BUILTIN_HEX_WORDS_WHITELIST,
  DEFAULT_HASH_MIN_LEN,
  type HashSpan,
} from './hash-detect.js';

/** Sentinels minted by the sidecar look like `⟦PII:0⟧` or `⟦HASH:0⟧`
 *  (the latter from the entropy-based hash/API-key scan in
 *  `submodules/privacy-filter/hash_detect.py`). */
const SENTINEL_REGEX = /\u27e6(?:PII|HASH):\d+\u27e7/g;
/** Longest sentinel we expect, used to size the streaming tail buffer. */
const MAX_SENTINEL_LEN = 24;

export type PrivacyFilterMode = 'sidecar' | 'local';

export interface PrivacyFilterConfig {
  /** Sidecar URL; empty string in `local` mode. */
  url: string;
  /** Redaction mode. */
  mode: PrivacyFilterMode;
  /** Sidecar-only: per-call timeout. */
  timeoutMs: number;
  /** Max combined text length before skipping redaction. */
  maxChars: number;
  /** Local-only: entropy threshold passed to `findHashSpans`. */
  entropyThreshold: number;
  /** Local-only: minimum hex token length to classify as a hash. */
  hashMinLen: number;
  /** Local-only: final whitelist (built-ins + user additions - removals). */
  whitelist: ReadonlySet<string>;
}

/** Sentinel -> original text mapping for one request/response cycle. */
export type PiiMapping = Record<string, string>;

/**
 * Per-call overrides sourced from the `[privacy_filter]` toml section.
 * When omitted, every field falls back to the documented default (or, for
 * `filter_url`, to the env-var `PRIVACY_FILTER_URL`).
 *
 * Activation is driven by `filter_mode`:
 *   * `filter_mode = "local"` — enable in-process hash-only redaction.
 *   * `filter_mode = "sidecar"` — enable sidecar redaction; a valid
 *     `filter_url` is also required (otherwise the plugin stays inert).
 *   * `filter_mode` omitted — the plugin is inert (unless the
 *     `PRIVACY_FILTER_URL` env var activates sidecar mode).
 */
export interface PrivacyFilterTomlConfig {
  filter_mode?: PrivacyFilterMode;
  filter_url?: string;
  timeout_ms?: number;
  max_chars?: number;
  entropy_threshold?: number;
  hash_min_len?: number;
  whitelist_add?: string[];
  whitelist_remove?: string[];
  whitelist_file?: string;
}

/**
 * Read privacy-filter configuration from env (always present in Workers /
 * Node bindings) and an optional toml section. Env vars override toml.
 *
 * Returns null when the plugin is fully disabled. The plugin is enabled
 * when any of these is true:
 *   * `PRIVACY_FILTER_URL` env var is set (forces sidecar mode), or
 *   * toml `filter_mode = "local"`, or
 *   * toml `filter_mode = "sidecar"` AND a valid `filter_url`.
 */
export function getPrivacyFilterConfig(
  env?: Env,
  toml?: PrivacyFilterTomlConfig | null,
): PrivacyFilterConfig | null {
  // Resolve the effective mode. `sidecar` is the default when a sidecar URL
  // is provided either via env or toml; `local` is opt-in via toml (no
  // env-var equivalent, since hash-only redaction is a deployment choice,
  // not a runtime one).
  const envUrl = env?.PRIVACY_FILTER_URL?.trim() || '';
  const tomlMode = toml?.filter_mode;
  const tomlUrl = toml?.filter_url?.trim() || '';

  let mode: PrivacyFilterMode;
  let url: string;
  if (tomlMode === 'local') {
    mode = 'local';
    url = ''; // unused in local mode
  } else if (envUrl) {
    mode = 'sidecar';
    url = envUrl;
  } else if (tomlMode === 'sidecar' && tomlUrl) {
    mode = 'sidecar';
    url = tomlUrl;
  } else {
    // `filter_mode` omitted, `filter_mode = "sidecar"` without `filter_url`,
    // or no toml section at all — the plugin stays inert.
    return null;
  }

  // Sidecar URL validation. In local mode the URL is ignored.
  if (mode === 'sidecar') {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`PRIVACY_FILTER_URL is not a valid URL: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`PRIVACY_FILTER_URL must use http or https, got: ${parsed.protocol}`);
    }
    if (!isInternalHost(parsed.hostname)) {
      throw new Error(`PRIVACY_FILTER_URL must point to localhost or a private/LAN address, got: ${parsed.hostname}`);
    }
    url = url.replace(/\/+$/, '');
  }

  // Endpoints-based gating was removed: when the filter is configured, it
  // always runs. `redactBody` no-ops on bodies with no `messages` / `system`
  // fields, so non-LLM paths (`/v1/embeddings`, `/dashboard/api/...`) are
  // safe by construction.

  // Fail-open was removed: the privacy filter is fail-closed by construction
  // (a privacy tool should never forward unredacted text on sidecar failure).

  // In local mode there's no sidecar to time out, but we still honor the
  // knob for forward-compat (a future local model might want a budget).
  const timeoutParsed = Number(env?.PRIVACY_FILTER_TIMEOUT_MS ?? toml?.timeout_ms);
  const timeoutMs = Number.isFinite(timeoutParsed) && timeoutParsed > 0 ? Math.floor(timeoutParsed) : 40000;

  const maxCharsParsed = Number(env?.PRIVACY_FILTER_MAX_CHARS ?? toml?.max_chars);
  const maxChars = Number.isFinite(maxCharsParsed) && maxCharsParsed > 0 ? Math.floor(maxCharsParsed) : 1024000;

  const entropyThreshold = Number.isFinite(Number(toml?.entropy_threshold))
    ? Number(toml?.entropy_threshold)
    : 3.3;

  const hashMinLenParsed = Number(toml?.hash_min_len);
  const hashMinLen = Number.isFinite(hashMinLenParsed) && hashMinLenParsed >= 1
    ? Math.floor(hashMinLenParsed)
    : DEFAULT_HASH_MIN_LEN;

  // Build the final whitelist for local mode. The whitelist is
  // unconditionally built so getPrivacyFilterConfig never reads FS at
  // construction time — file reads are deferred to redactBody (Node-only,
  // see `redactLocal`).
  const whitelist = buildWhitelist(
    toml?.whitelist_add ?? [],
    toml?.whitelist_remove ?? [],
    null, // no FS read at config-load time
    null,
  );

  return {
    url,
    mode,
    timeoutMs,
    maxChars,
    entropyThreshold,
    hashMinLen,
    whitelist,
  };
}

/**
 * A reference to one text fragment inside a request body, with a setter so we
 * can write the redacted version back in place.
 */
interface TextRef {
  get(): string;
  set(value: string): void;
}

/**
 * Collect editable references to every user-visible text fragment in a parsed
 * request body. Understands the Anthropic Messages shape (string or content
 * blocks, plus `system`), the OpenAI chat shape, and the Gemini
 * generateContent shape (contents[].parts[]). Non-text block types
 * (image, document, image_url, inlineData) are skipped — see module docstring.
 */
function collectTextRefs(body: Record<string, unknown>): TextRef[] {
  const refs: TextRef[] = [];

  // system: string | Array<{type:'text', text}>
  const system = body.system;
  if (typeof system === 'string') {
    refs.push({ get: () => body.system as string, set: (v) => { body.system = v; } });
  } else if (Array.isArray(system)) {
    for (const block of system) {
      if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
        const b = block as Record<string, unknown>;
        if (typeof b.text === 'string') {
          refs.push({ get: () => b.text as string, set: (v) => { b.text = v; } });
        }
      }
    }
  }

  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;
      const m = msg as Record<string, unknown>;
      const content = m.content;
      if (typeof content === 'string') {
        refs.push({ get: () => m.content as string, set: (v) => { m.content = v; } });
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (!part || typeof part !== 'object') continue;
          const p = part as Record<string, unknown>;
          // Only text blocks. image / document / image_url / inlineData blocks
          // are skipped — their binary payloads must not be redacted.
          if (p.type === 'text' && typeof p.text === 'string') {
            refs.push({ get: () => p.text as string, set: (v) => { p.text = v; } });
          }
        }
      }
    }
  }

  // Gemini generateContent / streamGenerateContent: contents[].parts[].text
  const contents = body.contents;
  if (Array.isArray(contents)) {
    for (const turn of contents) {
      if (!turn || typeof turn !== 'object') continue;
      const t = turn as Record<string, unknown>;
      if (!Array.isArray(t.parts)) continue;
      for (const part of t.parts) {
        if (!part || typeof part !== 'object') continue;
        const p = part as Record<string, unknown>;
        // Skip inlineData parts (base64 media bytes) — only collect plain text.
        if (typeof p.text === 'string' && !('inlineData' in p)) {
          refs.push({ get: () => p.text as string, set: (v) => { p.text = v; } });
        }
      }
    }
  }

  return refs;
}

export interface RedactResult {
  /** Possibly-mutated body (same object reference as input). */
  body: Record<string, unknown>;
  /** Sentinel -> original mapping; empty when nothing was redacted. */
  mapping: PiiMapping;
}

/**
 * Redact PII out of a request body. In `sidecar` mode this calls the OPF
 * privacy-filter sidecar over HTTP; in `local` mode it runs the in-process
 * hash detector on every text fragment.
 *
 * On failure (sidecar unreachable / malformed response / FS whitelist
 * unreadable in local mode), throws — the privacy filter is fail-closed by
 * construction; we never forward unredacted text upstream.
 */
export async function redactBody(
  config: PrivacyFilterConfig,
  body: Record<string, unknown>,
): Promise<RedactResult> {
  const refs = collectTextRefs(body);
  if (refs.length === 0) return { body, mapping: {} };

  const texts = refs.map((r) => r.get());
  const totalChars = texts.reduce((sum, t) => sum + t.length, 0);
  if (totalChars === 0 || totalChars > config.maxChars) {
    return { body, mapping: {} };
  }

  if (config.mode === 'local') {
    return redactLocal(config, body, refs, texts);
  }
  return redactSidecar(config, body, refs, texts);
}

/**
 * Sidecar path: POST the texts to `${url}/redact` and apply the returned
 * `redacted[]` array back onto the text refs. Throws on any transport /
 * shape error — fail-closed by design (the privacy filter never forwards
 * unredacted text upstream). The answer body is read under §5.7's cap, so a
 * body over `max_response_bytes` throws that error as itself rather than as a
 * sidecar failure.
 */
async function redactSidecar(
  config: PrivacyFilterConfig,
  body: Record<string, unknown>,
  refs: TextRef[],
  texts: string[],
): Promise<RedactResult> {
  let payload: { redacted?: unknown; mapping?: unknown };
  let resp: Response;
  try {
    resp = await fetch(`${config.url}/redact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    throw new Error(`privacy filter unavailable: ${(error as Error).message}`);
  }
  if (!resp.ok) {
    throw new Error(`privacy filter unavailable: sidecar returned ${resp.status}`);
  }
  // §5.7: the sidecar answers with the redacted prompt text — as large as the
  // request the filter accepted (`maxChars`), so the read is bounded like every
  // other remote body: `max_response_bytes` caps it, the parse charges §5.9, and
  // above `threshold_bytes` the bytes live on a spill meanwhile. The body is
  // never logged (it is the user's own text), so this is the receive *without*
  // the trace stage.
  try {
    payload = await consumeResponseText(resp.body, (text) => JSON.parse(text) as { redacted?: unknown; mapping?: unknown });
  } catch (error) {
    // A proxy limit — the response cap, a spill failure, a §5.9 refusal — is not
    // the sidecar being unavailable: rethrow it as itself so the request fails
    // with the real reason (rule #8). The filter stays fail-closed either way.
    if (error instanceof ClaudeProxyError) throw error;
    throw new Error(`privacy filter unavailable: ${(error as Error).message}`);
  }

  const redacted = payload.redacted;
  if (!Array.isArray(redacted) || redacted.length !== refs.length) {
    throw new Error('privacy filter returned malformed response');
  }

  for (let i = 0; i < refs.length; i++) {
    if (typeof redacted[i] === 'string') {
      refs[i].set(redacted[i] as string);
    }
  }

  const mapping = (payload.mapping && typeof payload.mapping === 'object'
    ? (payload.mapping as PiiMapping)
    : {}) as PiiMapping;

  return { body, mapping };
}

/**
 * Local path: run `findHashSpans` on each text fragment and replace
 * detected spans with `⟦HASH:n⟧` sentinels, populating the mapping with
 * the original tokens. No network / FS access; in particular, the
 * optional `whitelist_file` (Node-only) is read once per request from
 * the in-process file system here. Errors are treated as fail-closed:
 * if the file is unreadable the redaction step throws and the request
 * fails rather than forwarding unredacted text.
 */
async function redactLocal(
  config: PrivacyFilterConfig,
  body: Record<string, unknown>,
  refs: TextRef[],
  texts: string[],
): Promise<RedactResult> {
  // Lazily materialize a per-call whitelist that may extend the config-time
  // whitelist with the contents of `whitelist_file`. We can't read the
  // file at config-load time because the file path may be set by a runtime
  // toml reload after the config object has already been cached.
  const whitelist = await resolveLocalWhitelist(config);

  let counter = 0;
  const mapping: PiiMapping = {};
  // Dedup by original token: identical tokens reuse one sentinel so a key
  // repeated across messages produces one mapping entry, not N.
  const tokenToSentinel = new Map<string, string>();
  const mintSentinel = (token: string): string => {
    const existing = tokenToSentinel.get(token);
    if (existing) return existing;
    const sentinel = `\u27e6HASH:${counter}\u27e7`;
    counter++;
    tokenToSentinel.set(token, sentinel);
    mapping[sentinel] = token;
    return sentinel;
  };
  const redacted: string[] = texts.map((text) => {
    if (!text) return text;
    const spans = findHashSpans(text, config.entropyThreshold, whitelist, config.hashMinLen);
    if (spans.length === 0) return text;
    return applySpans(text, spans, mintSentinel);
  });

  // Write the redacted strings back into the body in place.
  for (let i = 0; i < refs.length; i++) {
    refs[i].set(redacted[i]);
  }

  return { body, mapping };
}

function applySpans(
  text: string,
  spans: HashSpan[],
  mintSentinel: (token: string) => string,
): string {
  // Iterate right-to-left so earlier indexes stay valid as we splice.
  let out = text;
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i];
    const sentinel = mintSentinel(span.token);
    out = out.slice(0, span.start) + sentinel + out.slice(span.end);
  }
  return out;
}

/**
 * If the config has a `whitelist_file` (only possible via a runtime toml
 * reload; the function `getPrivacyFilterConfig` itself never reads the
 * file), extend the in-memory whitelist with its contents. Errors here
 * are non-fatal: a missing whitelist file just falls back to the
 * in-memory whitelist built at config-load time.
 */
async function resolveLocalWhitelist(config: PrivacyFilterConfig): Promise<ReadonlySet<string>> {
  // The toml-side path is not stored on PrivacyFilterConfig (it would
  // need an FS reader callback to be Workers-safe). For now, we treat
  // the in-memory whitelist as authoritative. The toml `whitelist_file`
  // knob is parsed but only consulted at config-load time when the
  // config-loader is Node-side — see `loadProxyConfig`. A future patch
  // can thread the reader through here if dynamic file hot-reload is
  // needed.
  return config.whitelist ?? BUILTIN_HEX_WORDS_WHITELIST;
}

/** Replace every sentinel in `text` with its original value. */
export function restoreText(text: string, mapping: PiiMapping): string {
  if (!text || Object.keys(mapping).length === 0) return text;
  let restoreCount = 0;
  let missCount = 0;
  const result = text.replace(SENTINEL_REGEX, (match) => {
    if (Object.prototype.hasOwnProperty.call(mapping, match)) {
      restoreCount++;
      return mapping[match];
    }
    missCount++;
    return match;
  });
  if (restoreCount > 0 || missCount > 0) {
    console.debug(`[PII-RESTORE] restoreText: ${restoreCount} replaced, ${missCount} unmatched sentinels (text ${text.length} -> ${result.length} chars)`);
  }
  return result;
}

/**
 * A TransformStream that restores sentinels in a streaming (SSE) response.
 * Keeps a small tail buffer so a sentinel split across two chunks is still
 * matched before being emitted.
 */
export function createRestoreTransformStream(mapping: PiiMapping): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  const hasMapping = Object.keys(mapping).length > 0;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      if (!hasMapping) {
        controller.enqueue(encoder.encode(buffer));
        buffer = '';
        return;
      }
      // Hold back only a genuinely incomplete trailing sentinel: an unclosed
      // sentinel-open bracket with no closing bracket after it. Complete
      // sentinels anywhere in the buffer are restored now, so a fixed-length
      // cut can never slice through a complete `⟦PII:n⟧`.
      let holdFrom = buffer.length;
      const lastOpen = buffer.lastIndexOf('\u27e6');
      if (
        lastOpen !== -1 &&
        buffer.indexOf('\u27e7', lastOpen) === -1 &&
        buffer.length - lastOpen <= MAX_SENTINEL_LEN
      ) {
        holdFrom = lastOpen;
      }
      const emit = buffer.slice(0, holdFrom);
      buffer = buffer.slice(holdFrom);
      if (emit) {
        controller.enqueue(encoder.encode(restoreText(emit, mapping)));
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) {
        controller.enqueue(encoder.encode(restoreText(buffer, mapping)));
      }
    },
  });
}
