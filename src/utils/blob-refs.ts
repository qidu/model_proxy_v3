/**
 * SSD spool — the §5.4/§9.3 ref layer: inline-binary extraction and rehydration.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md (§5.2, §5.4, §9.3, §10).
 *
 * A ref replaces one inline base64 payload *at an explicit, schema-qualified
 * position* with a small object naming the blob. The allowlist is the §5.4 one —
 * Claude base64 image/document sources, Chat Completions image/audio/file parts,
 * Gemini `inline_data`/`inlineData`, and Responses image/file/inline-skill parts.
 * §5.7's response allowlist is a second, deliberately different set of positions
 * ({@link extractResponseBlobs}): Gemini response parts, plus Responses
 * `image_generation_call.result` — and *not* the request positions, because the
 * documented response schemas do not carry Claude or Chat Completions assistant
 * images. Only the positions differ; the rules below are shared.
 * There is deliberately no "long base64-looking string" heuristic (§9.3): a
 * text-inspecting pass that forgets to rehydrate silently miscounts, and that
 * failure is invisible in the output. So every position that can hold a ref has
 * its own predicate here, plus a round-trip test.
 *
 * Eligibility is narrower than the allowlist: a payload that `JSON.stringify`
 * would have to escape is left inline (`JSON_VERBATIM_PAYLOAD` below), because
 * the §5.3 shape-3 serializer reports an exact `Content-Length` from the skeleton
 * plus each ref's recorded `size`, and that only holds while the payload reaches
 * the wire verbatim. Such a payload is counted in `InlineExtraction.skipped`
 * rather than silently passed over (repo rule #8).
 *
 * What a ref records (§5.4):
 *   - `hash` and `size`: the blob store's identity and byte count for the payload.
 *   - `prefix`: the original `data:<media-type>;base64,` text, `''` when the
 *     position held bare base64. Only the payload goes to the blob, so
 *     rehydration reproduces the original field value byte for byte.
 *   - `kind`: which predicate matched — diagnostics, and for consumers that need
 *     to know the source shape.
 *
 * The ref is an *object* where the client sent a string, not a sentinel string.
 * A consumer that is not ref-aware then fails loudly (`source.data` is not a
 * string any more) instead of quietly measuring a placeholder (§9.3, repo rule
 * #8). Refs are only ever written to the literal keys read by these predicates,
 * so a client-supplied `__proto__` field cannot be assigned through.
 *
 * Extraction takes one lease per ref (`putBlob`), so whoever owns an extracted
 * body must release each of its refs exactly once — {@link releaseInlineBlobs}
 * is that counterpart, and {@link releaseExtractedBlobs} is the same release
 * driven from the extraction's own list of applied leases rather than from a
 * walk of the body. Extraction is all-or-nothing: if a payload cannot be
 * stored, the replacements already applied are undone, their leases released,
 * and the error rethrown, so a caller never receives a half-extracted body or
 * leaks a lease.
 *
 * The owner in practice is the request handler (`src/index.ts`): it extracts
 * right after parsing, and the leases go back from the extraction's list when
 * the request ends. The send boundary does not expand: it keeps the refs
 * (plain JSON data) so that routing, the attempt builders and conversion never
 * carry the payloads twice, and each dispatch handler's send decides from the
 * body it is handed whether to put the payloads back (shape 2) or to hand the
 * refs to `createRefAwareJsonBody` and stream each payload at the offset its ref
 * occupies (shape 3). Nothing a live route sends expands any more: the already
 * OpenAI bodies, the converted ones and the passthroughs all stream, and the one
 * caller of {@link rehydrateInlineBlobs} that still materializes a request body
 * is the `sdk://` branch of `src/handlers/claude.ts` and `src/handlers/messages.ts`,
 * which answers 501 before its handler reads the body. Refs are held
 * across everything before dispatch, which is the RAM relief
 * §5.2 asks for: expanding at the boundary would defeat the extraction
 * entirely. The auth server is the only pre-dispatch consumer that must see the
 * old bytes, so `src/index.ts` expands a throwaway clone for `auth_with_body`,
 * or sends §5.8's projected links instead.
 *
 * Owners of one payload share the blob's single lease rather than taking
 * independent ones: the L2 index counts them (`refs`, §5.5), so a ref's `hash`
 * is its lease identity and a separate `leaseId` would be a second counter over
 * the same lifetime. Renewal is structural for the same reason — `lastUsed` only
 * decides anything once `refs` reaches 0, and both `retainBlob` and `releaseBlob`
 * refresh it, so a blob held by a live exchange is never idle, never expired, and
 * never evicted. {@link cloneInlineBlobs} is the §5.2 attempt body: a
 * `structuredClone` plus one `retain()` per ref.
 *
 * `[spool] enabled = false` is not a fallback: extraction calls the store, which
 * refuses rather than quietly caching payloads in RAM (§9.1). Callers gate on the
 * config; a body with nothing to extract is a no-op either way.
 *
 * Two stores, one algorithm. Request payloads go to the §5.4 cross-request cache;
 * response and event payloads go to a per-response scratch store that is deleted
 * when the response ends (§5.7). So the store is a parameter ({@link RefStorage}),
 * not a module import: the walk, the allowlists, the eligibility rule and the
 * release contract are identical for both, and the only thing that may differ is
 * *where the bytes land*. That is why {@link extractResponseBlobs} takes its store
 * as a required argument — a response payload cannot reach the cross-request cache
 * by forgetting to pass one.
 */

import { BlobStoreError, putBlob, readBlob, releaseBlob, retainBlob } from './blob-store.js';

/**
 * Where a ref's bytes live: the §5.4 cache, or the §5.7 per-response scratch store.
 *
 * Three operations are all the ref layer needs — take one lease, give one back,
 * read the payload. Deliberately not `retain`: holding one payload under more
 * owners is the §5.2 attempt-body clone, which only ever copies the effective
 * (request) body and so stays cache-only (`retainBlob` in `cloneInlineBlobs`).
 */
export interface RefStorage {
  /** Store one base64 payload, taking one lease; repeats dedupe to the same hash. */
  put(base64: string): Promise<{ hash: string; size: number }>;
  /** Give back one lease; the last release makes the payload eligible for deletion. */
  release(hash: string): void;
  /** The stored base64 payload. */
  read(hash: string): Promise<string>;
}

/** The §5.4 cross-request blob cache, as the ref layer sees it. */
export const CACHE_STORAGE: RefStorage = {
  put: async (base64) => {
    const blob = await putBlob(base64);
    return { hash: blob.hash, size: blob.size };
  },
  release: (hash) => releaseBlob(hash),
  read: async (hash) => (await readBlob(hash)).base64,
};

/** The marker property every ref carries; a ref is recognized by it alone. */
export const BLOB_REF_MARKER = '$spoolBlob';

/**
 * Which predicate produced a ref. One name per allowlisted position, so a ref in
 * a test or a log says where it came from without a second lookup.
 *
 * `gemini-inline-data` is the one name shared by both allowlists: the Gemini part
 * carries no discriminator, so `inline_data`/`inlineData` *is* the position on the
 * request and on the response side alike (§5.4, §5.7).
 */
export type BlobRefKind =
  | 'claude-source-data'
  | 'chat-image-url'
  | 'chat-input-audio'
  | 'chat-file-data'
  | 'gemini-inline-data'
  | 'interactions-media-data'
  | 'responses-input-image'
  | 'responses-input-file'
  | 'responses-inline-skill'
  | 'responses-image-generation-result';

/** A stored payload standing in for the inline field it replaced (§5.4). */
export interface BlobRef {
  [BLOB_REF_MARKER]: true;
  kind: BlobRefKind;
  /** sha256 of the base64 text — the blob's identity (§5.4). */
  hash: string;
  /** The base64 character count, which is also the blob's byte count. */
  size: number;
  /** The original `data:…;base64,` prefix, `''` when the field held bare base64. */
  prefix: string;
}

/** A plain JSON object, i.e. something that can hold a payload or a ref. */
type Holder = Record<string, unknown>;

/** How the allowlisted field spells its payload. */
type Form = 'bare' | 'data-url' | 'either';

/** One allowlisted payload found in a body: where it is, and what to store. */
interface Position {
  /** The object holding the field — a nested one, e.g. a Claude `source`. */
  holder: Holder;
  key: string;
  kind: BlobRefKind;
  /** The base64 text that goes to the blob store. */
  payload: string;
  /** The exact text that preceded the payload in the field, `''` for bare. */
  prefix: string;
}

/** A ref that extraction applied, with everything needed to undo it. */
interface Applied {
  holder: Holder;
  key: string;
  /** The original field value, restored if extraction fails part-way. */
  original: string;
  hash: string;
}

/** `data:<media-type>;base64,<payload>` — the only data URL form that is a ref. */
const DATA_URL_PATTERN = /^(data:[^,]*;base64,)(.+)$/is;

/** A URL with a scheme, i.e. a remote fetch and not inline bytes. */
const REMOTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Printable ASCII with no `"` and no `\` — text `JSON.stringify` copies verbatim
 * into a string literal, so `prefix + payload` costs exactly one byte per
 * character on the wire.
 *
 * This is the §5.3 shape-3 eligibility rule: the ref-aware serializer reports an
 * exact `Content-Length` from the skeleton plus each ref's recorded `size`, and
 * that arithmetic only holds while the payload needs no escaping. Base64 — and
 * the URL-safe alphabet `-`/`_` — satisfies it; anything JSON would escape
 * (`"`, `\`, a control character, non-ASCII) stays inline instead of becoming a
 * ref. Extraction is an optimization, so declining it here costs RAM relief for
 * that one payload and changes no bytes; a body carrying such a value is
 * pathological anyway, since these positions are base64 by schema.
 */
const JSON_VERBATIM_PAYLOAD = /^[\x20\x21\x23-\x5b\x5d-\x7e]+$/;

function isRecord(value: unknown): value is Holder {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * True when `value` is a ref, i.e. when it carries the marker and names a blob.
 *
 * Identification only: a ref in a request body can be *forged*, so a field is
 * never used to build bytes before it is checked — {@link readRef} validates
 * `size` and `prefix`, and the store validates the hash's exact shape before it
 * becomes a path. A value carrying the marker without a hash is not a ref, and
 * is left where it is.
 */
export function isBlobRef(value: unknown): value is BlobRef {
  return isRecord(value) && value[BLOB_REF_MARKER] === true && typeof value.hash === 'string';
}

/** Split a base64 `data:` URL into the prefix to keep and the payload to store. */
function splitDataUrl(value: unknown): { prefix: string; payload: string } | undefined {
  if (typeof value !== 'string') return undefined;
  const match = DATA_URL_PATTERN.exec(value);
  if (!match) return undefined;
  return { prefix: match[1], payload: match[2] };
}

/**
 * How a field spells its payload — the prefix to keep and the bytes to store — or
 * nothing when the field holds no inline payload to extract.
 *
 * The bare form is any non-empty string that is not a remote URL. A value at one
 * of these positions is base64 by schema, so it is not validated as base64 here:
 * extraction only has to be *reversible*, and re-encoding or rejecting would both
 * change bytes the client sent. The remote-URL check is what keeps
 * `file.file_data` holding `https://…` from becoming a blob.
 */
function candidateFor(value: unknown, form: Form): { prefix: string; payload: string } | undefined {
  if (form !== 'bare') {
    const dataUrl = splitDataUrl(value);
    if (dataUrl) return dataUrl;
    if (form === 'data-url') return undefined;
  }
  if (typeof value !== 'string' || value === '' || REMOTE_URL_PATTERN.test(value)) return undefined;
  return { prefix: '', payload: value };
}

/** The `add` closure a predicate set uses to offer one allowlisted position. */
type AddPosition = (holder: Holder, key: string, kind: BlobRefKind, form: Form) => void;

/** One predicate set's findings for a node, and what it left inline. */
interface FoundPositions {
  positions: Position[];
  ineligible: number;
}

/** How one allowlist reads a single node: §5.4 for requests, §5.7 for responses. */
type PositionFinder = (node: Holder) => FoundPositions;

/**
 * Run one predicate set with the shared accumulator: the eligibility rule and the
 * application order live here, and each allowlist only says which fields it reads.
 */
function findPositions(predicates: (add: AddPosition) => void): FoundPositions {
  const found: Position[] = [];
  let ineligible = 0;

  const add: AddPosition = (holder, key, kind, form) => {
    const candidate = candidateFor(holder[key], form);
    if (candidate === undefined) return;
    if (!JSON_VERBATIM_PAYLOAD.test(candidate.prefix + candidate.payload)) {
      ineligible += 1;
      return;
    }
    found.push({ holder, key, kind, payload: candidate.payload, prefix: candidate.prefix });
  };

  predicates(add);
  return { positions: found, ineligible };
}

/**
 * The Gemini part, appended by both allowlists: it declares no discriminator, so
 * `inline_data`/`inlineData` *is* the shape, for every declared MIME type.
 * `file_data`/`fileData` holds a URI rather than inline bytes.
 */
function addGeminiPart(node: Holder, add: AddPosition): void {
  for (const key of ['inline_data', 'inlineData'] as const) {
    const part = node[key];
    if (isRecord(part)) add(part, 'data', 'gemini-inline-data', 'bare');
  }
}

/**
 * The Interactions `Content` media part, appended by both allowlists: it names
 * itself with `type` (`image`, `audio`, `video`, `document`) and carries its bytes
 * bare in `data`, where the generateContent part declares no discriminator and
 * nests them under `inline_data`.
 *
 * `Content` is the one schema the Interactions API uses in *both* directions —
 * a request's `input` and a response's `outputs` — which is why this is the only
 * predicate the response allowlist shares with the request's. Its `type` values
 * overlap Claude's, so the two are told apart by where the payload sits: `data`
 * here, `source.data` there. Each predicate is a no-op on the other's shape.
 */
function addInteractionsMedia(node: Holder, add: AddPosition): void {
  if (node.type === 'image' || node.type === 'audio' || node.type === 'video' || node.type === 'document') {
    add(node, 'data', 'interactions-media-data', 'bare');
  }
}

/**
 * Every §5.4 payload position in one request node, keyed on the documented `type`
 * discriminators. Anything the client could put in a field of the same name
 * elsewhere is untouched.
 */
function positionsFor(node: Holder): FoundPositions {
  return findPositions((add) => {
    switch (node.type) {
      case 'image':
      case 'document': {
        // Claude Messages: base64 image and base64 (PDF) document sources. The
        // `text` and `url` source types have no inline payload and are excluded.
        const source = node.source;
        if (isRecord(source) && source.type === 'base64') add(source, 'data', 'claude-source-data', 'bare');
        break;
      }
      case 'image_url': {
        // Chat Completions: the URL is an object; only a base64 data URL is inline.
        const image = node.image_url;
        if (isRecord(image)) add(image, 'url', 'chat-image-url', 'data-url');
        break;
      }
      case 'input_audio':
        if (isRecord(node.input_audio)) add(node.input_audio, 'data', 'chat-input-audio', 'bare');
        break;
      case 'file':
        // Chat Completions: base64 or a data URL. `file_id` is not an inline payload.
        if (isRecord(node.file)) add(node.file, 'file_data', 'chat-file-data', 'either');
        break;
      case 'input_image':
        // Responses puts the URL directly on the part; the Chat→Responses converter
        // in this repo relays the Chat *object* form, so both spellings are read.
        if (isRecord(node.image_url)) add(node.image_url, 'url', 'responses-input-image', 'data-url');
        else add(node, 'image_url', 'responses-input-image', 'data-url');
        break;
      case 'input_file':
        // Responses puts it directly on the part. `file_id` is not an inline payload.
        add(node, 'file_data', 'responses-input-file', 'either');
        break;
      case 'inline': {
        // An inline skill is a ZIP by contract; any other media type is not one.
        const source = node.source;
        if (isRecord(source) && source.type === 'base64' && source.media_type === 'application/zip') {
          add(source, 'data', 'responses-inline-skill', 'bare');
        }
        break;
      }
      default:
        break;
    }

    addGeminiPart(node, add);
    addInteractionsMedia(node, add);
  });
}

/**
 * Every §5.7 payload position in one response node, in the same shape.
 *
 * This is what the plan's response allowlist is: Gemini response content parts,
 * and OpenAI Responses output items carrying a generated image, "whether
 * encountered in a completed JSON response or an SSE output-item event" — which
 * needs no special case, because an SSE data line is walked as the event object
 * it is and the item is found wherever it sits in it.
 *
 * It deliberately omits every request predicate. Claude assistant image blocks
 * and Chat Completions assistant image parts stay O(B): the documented response
 * schemas do not carry them, so reusing `source.data` or `image_url` here would
 * be exactly the indiscriminate use of a request predicate §5.7 rules out. A
 * streaming binary field outside this list needs its own predicate and
 * round-trip tests before it is added.
 *
 * The one predicate it shares with the request list is the Interactions media
 * content (`addInteractionsMedia`), because that schema — unlike Claude's or Chat
 * Completions' — is the documented shape of a response's `outputs` as well as a
 * request's `input`.
 */
function positionsForResponse(node: Holder): FoundPositions {
  return findPositions((add) => {
    // `result` is bare base64 by schema, and null until the call completes — a
    // non-string is not a payload, so an in-progress item extracts nothing.
    if (node.type === 'image_generation_call') add(node, 'result', 'responses-image-generation-result', 'bare');

    addGeminiPart(node, add);
    addInteractionsMedia(node, add);
  });
}

/** What extraction did to a body. */
export interface InlineExtraction {
  /** How many payloads became refs. */
  refs: number;
  /**
   * Payload bytes taken out of the parsed body. This is heap relief, not disk
   * usage: two identical payloads are two refs over one stored blob (§5.4).
   */
  bytes: number;
  /**
   * Payloads found at an allowlisted position but left inline, because they hold
   * characters `JSON.stringify` would escape and so break shape 3's exact
   * `Content-Length` (§5.3). Reported, not silent: a non-zero count means this
   * body got less RAM relief than its schema allows (repo rule #8).
   */
  skipped: number;
  /**
   * The leases this extraction took, in application order — one entry per ref,
   * repeats included (two refs to one payload are two leases, §5.5).
   *
   * This is the owner's release list. §5.2 has the effective body hold its refs
   * until no more attempts can be created, so the body outlives them: release
   * from this list ({@link releaseExtractedBlobs}) rather than by walking the
   * tree, where a client-forged ref names a blob this request never leased.
   */
  hashes: string[];
  /**
   * Every *distinct* blob behind those leases, in first-lease order: the identity
   * and the stored length an upload must declare (§5.8).
   *
   * Deduped, unlike `hashes`: two refs to one payload are two leases but one
   * stored object (§5.4), so they are one upload. Taken here, where the leases
   * are, so the caller never has to walk the body for sizes — the same walk that
   * would also find a client-forged ref and offer to upload a blob this request
   * never leased.
   */
  blobs: Array<{ hash: string; size: number }>;
}

/**
 * Replace every allowlisted inline payload in `body` with a {@link BlobRef}.
 *
 * `body` is mutated in place — the parse that produced it already holds it, and
 * §5.2 keeps one body per attempt rather than a second copy. Extraction is
 * idempotent: a position already holding a ref is not a string any more, so a
 * second pass finds nothing.
 *
 * Throws whatever the store throws (`BlobCapacityError` when the disk budget
 * cannot be met without breaking a lease, `BlobStoreError` on a write failure,
 * the plain disabled-spool error) after restoring the body.
 */
export async function extractInlineBlobs(body: unknown): Promise<InlineExtraction> {
  return await extract(body, positionsFor, CACHE_STORAGE);
}

/**
 * Replace every §5.7 response-allowlist payload in `body` with a
 * {@link BlobRef} — Gemini response parts and Responses generated-image results.
 *
 * The counterpart of {@link extractInlineBlobs} for a parsed *response* body or
 * SSE event object, and the same in every other respect: in place, idempotent,
 * all-or-nothing, one lease per ref. It returns the same
 * {@link InlineExtraction}, whose `hashes` is again the owner's release list —
 * §5.7 deletes a response's blobs after the client write completes or the
 * exchange aborts, and no response blob populates the cross-request cache by
 * default, so the release is the ordinary one.
 *
 * `storage` is required and is the caller's per-response scratch store
 * (`ResponseBlobStore` in `response-blobs.ts`), not defaulted to the cache: §5.7's
 * "do not populate the cross-request cache by default" is a property of the code,
 * not of every call site remembering it.
 */
export async function extractResponseBlobs(body: unknown, storage: RefStorage): Promise<InlineExtraction> {
  return await extract(body, positionsForResponse, storage);
}

/** The all-or-nothing replacement loop, shared by both allowlists. */
async function extract(body: unknown, find: PositionFinder, storage: RefStorage): Promise<InlineExtraction> {
  const applied: Applied[] = [];
  const blobs: Array<{ hash: string; size: number }> = [];
  const seen = new Set<string>();
  let bytes = 0;
  let skipped = 0;

  try {
    const replace = async (position: Position): Promise<void> => {
      const blob = await storage.put(position.payload);
      const original = position.holder[position.key] as string;
      const ref: BlobRef = {
        [BLOB_REF_MARKER]: true,
        kind: position.kind,
        hash: blob.hash,
        size: blob.size,
        prefix: position.prefix,
      };
      position.holder[position.key] = ref;
      applied.push({ holder: position.holder, key: position.key, original, hash: blob.hash });
      bytes += blob.size;
      // First lease of this hash names it for the upload (§5.8). putBlob is
      // content-addressed, so a repeat is the same stored object at the same
      // size — one entry, not two.
      if (!seen.has(blob.hash)) {
        seen.add(blob.hash);
        blobs.push({ hash: blob.hash, size: blob.size });
      }
    };

    skipped = await walkPositions(body, replace, find);
  } catch (error) {
    await undo(applied, storage);
    throw error;
  }

  return { refs: applied.length, bytes, skipped, hashes: applied.map((item) => item.hash), blobs };
}

/**
 * Put every ref's original field value back, reading each blob from the store.
 *
 * This is §5.3 shape 2, which the egress no longer takes by default: every live
 * send in this repo either keeps the refs and streams them (shape 3) or forwards a
 * payload the client never extracted. (§5.4: "rehydration must happen only where
 * original bytes are semantically required".) Where it is still called, expansion
 * has to precede validation (a validator rejects a ref where it expects the base64
 * string), `before_upstream` and conversion, so that everything downstream sees the
 * bytes the client sent — the `sdk://` branches of `claude.ts` and `messages.ts`
 * are the remaining request-body callers, and both answer 501 before their handler
 * reads the body. It does not touch leases — the body's owner releases them.
 *
 * Returns how many refs were expanded (0 for a ref-free body, which is the
 * common case). Throws when a ref does not match its blob (a blob evicted under
 * a live ref, or a forged ref): substituting a different payload, or an empty
 * one, would send bytes the client never sent.
 *
 * `storage` defaults to the cross-request cache, which is where request bodies'
 * refs live. A response body's refs live in that response's scratch store, so its
 * egress passes the store explicitly.
 */
export async function rehydrateInlineBlobs(body: unknown, storage: RefStorage = CACHE_STORAGE): Promise<number> {
  return await restoreRefs(body, storage);
}

/** Every ref in `body`, in traversal order, including repeats of one blob. */
export function collectBlobRefs(body: unknown): BlobRef[] {
  const refs: BlobRef[] = [];

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!isRecord(node)) return;
    for (const value of Object.values(node)) {
      if (isBlobRef(value)) {
        refs.push(value);
        continue; // a ref holds metadata, never further refs
      }
      walk(value);
    }
  };

  walk(body);
  return refs;
}

/**
 * Release every ref in `body`, one release per ref, and report how many.
 *
 * One release per *ref*, not per distinct hash: two refs to the same payload
 * took two leases (`putBlob` counts owners, §5.5), so both must be given back.
 * A release that fails throws, leaving the earlier ones released — an
 * accounting error must not be swallowed into a count.
 */
export function releaseInlineBlobs(body: unknown): number {
  const refs = collectBlobRefs(body);
  for (const ref of refs) releaseBlob(ref.hash);
  return refs.length;
}

/**
 * Give back the leases `extraction` took, one per applied ref, and report how
 * many. This is the effective body's release (§5.2: its refs stay leased until
 * no more attempts can be created).
 *
 * Unlike {@link releaseInlineBlobs} this reads the extraction's own list, not
 * the body, so a ref a client forged into a field of its own can only refuse
 * that client's request — it cannot make the owner's release throw on a hash
 * this request never leased.
 *
 * A release that fails throws, as {@link releaseInlineBlobs} does, leaving the
 * earlier ones released. `storage` defaults to the cross-request cache; a response
 * extraction's leases belong to its scratch store, so pass that store.
 */
export function releaseExtractedBlobs(extraction: InlineExtraction, storage: RefStorage = CACHE_STORAGE): number {
  for (const hash of extraction.hashes) storage.release(hash);
  return extraction.hashes.length;
}

/**
 * The §5.2 attempt body: a deep copy of `body` whose every ref holds its own
 * lease, taken with `retain()` on the blob the copy still names.
 *
 * A conversion path may send a body built from the extracted one, and the two
 * must not share mutable state or a single release: the copy's refs are the same
 * blobs under one more owner each (§5.5). The new owner releases each of them
 * exactly once — {@link releaseInlineBlobs} on the clone — in its `finally`.
 *
 * The copy is made before any lease is taken, so a body `structuredClone` cannot
 * copy (a function, a class instance) refuses here with nothing to undo. A ref
 * that names no blob (forged by the client, or released underneath this body)
 * refuses the whole clone, and the leases already taken are given back: a caller
 * never receives a half-leased copy.
 */
export function cloneInlineBlobs<T>(body: T): T {
  const clone = structuredClone(body);

  const retained: string[] = [];
  try {
    for (const ref of collectBlobRefs(clone)) {
      retainBlob(ref.hash);
      retained.push(ref.hash);
    }
  } catch (error) {
    releaseQuietly(retained, CACHE_STORAGE, 'after a failed attempt-body clone');
    throw error;
  }

  return clone;
}

/**
 * Visit every payload position one allowlist finds in a parsed JSON tree,
 * returning how many payloads were left inline because JSON would escape them.
 */
async function walkPositions(
  node: unknown,
  visit: (position: Position) => Promise<void>,
  find: PositionFinder,
): Promise<number> {
  if (Array.isArray(node)) {
    let ineligible = 0;
    for (const item of node) ineligible += await walkPositions(item, visit, find);
    return ineligible;
  }
  if (!isRecord(node)) return 0;

  const { positions, ineligible } = find(node);
  for (const position of positions) {
    await visit(position);
  }
  let nested = ineligible;
  for (const value of Object.values(node)) {
    if (isBlobRef(value)) continue; // a ref holds metadata, never further refs
    nested += await walkPositions(value, visit, find);
  }
  return nested;
}

/** Expand every ref in a parsed JSON tree back into the string it replaced. */
async function restoreRefs(node: unknown, storage: RefStorage): Promise<number> {
  if (Array.isArray(node)) {
    let expanded = 0;
    for (const item of node) expanded += await restoreRefs(item, storage);
    return expanded;
  }
  if (!isRecord(node)) return 0;

  let expanded = 0;
  for (const [key, value] of Object.entries(node)) {
    if (isBlobRef(value)) {
      node[key] = await readRef(value, storage);
      expanded += 1;
      continue;
    }
    expanded += await restoreRefs(value, storage);
  }
  return expanded;
}

/**
 * Refuse a ref that does not carry the metadata a value is built from.
 *
 * A ref in a request body can be *forged*, so every consumer of one checks the
 * shape before using it: {@link readRef} before it concatenates, and the §5.3
 * shape-3 serializer before it does arithmetic on `size`. Refusing beats
 * substituting — `undefined + base64` would forward a payload with the literal
 * text "undefined" glued to it (repo rule #8).
 *
 * `size` must be a non-negative integer as well as a number, because both
 * consumers spend it: a fractional or negative size would not name a byte count
 * to compare against or to add into a `Content-Length`.
 */
export function assertRefShape(ref: BlobRef): void {
  if (typeof ref.prefix !== 'string' || !Number.isInteger(ref.size) || ref.size < 0) {
    throw new BlobStoreError(`[spool] malformed ref for blob ${ref.hash}: ${JSON.stringify(ref)}`);
  }
}

/**
 * Move one ref to another allowlisted wire position without taking or releasing
 * a lease. The same body owner keeps the same blob; only the position metadata
 * and rehydration prefix change.
 */
export function rebindBlobRef(ref: BlobRef, kind: BlobRefKind, prefix: string): BlobRef {
  assertRefShape(ref);
  return { ...ref, kind, prefix };
}

/** The field value a ref replaced: its recorded prefix plus the stored payload. */
async function readRef(ref: BlobRef, storage: RefStorage): Promise<string> {
  assertRefShape(ref);
  const base64 = await storage.read(ref.hash);
  if (base64.length !== ref.size) {
    throw new BlobStoreError(
      `[spool] ref ${ref.hash} records ${ref.size} bytes but the blob holds ${base64.length}`,
    );
  }
  return ref.prefix + base64;
}

/**
 * Undo applied replacements, restoring the exact original text of each field.
 *
 * Release failures are reported, not thrown: the extraction error is what the
 * caller must see, and this only says a lease is still held.
 */
async function undo(applied: Applied[], storage: RefStorage): Promise<void> {
  for (const item of applied.reverse()) {
    item.holder[item.key] = item.original;
  }
  releaseQuietly(applied.map((item) => item.hash), storage, 'after a failed inline extraction');
}

/**
 * Release each hash, reporting (never throwing on) failures.
 *
 * Only for unwind paths: the error that sent the caller here is the report, and
 * this adds what was left leased rather than replacing it (repo rule #8 — it is
 * said out loud, not swallowed).
 */
function releaseQuietly(hashes: string[], storage: RefStorage, context: string): void {
  const failures: string[] = [];
  for (const hash of hashes) {
    try {
      storage.release(hash);
    } catch (error) {
      failures.push(`${hash}: ${(error as Error).message}`);
    }
  }
  if (failures.length > 0) {
    console.warn(`[spool] ${failures.length} lease(s) still held ${context}: ${failures.join('; ')}`);
  }
}
