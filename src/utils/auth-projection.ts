/**
 * SSD spool — the §5.8 `auth_with_body` external-link projection.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md (§5.8, §10).
 *
 * The auth sidecar has to see the post-privacy/kompress/judge body, but it does
 * not need inline binary under an updated auth contract. When external link
 * upload is configured, the auth request carries this **projection** instead:
 * text and tools keep their final mutated values, and each request `BlobRef` is
 * replaced — at the same field path, with the surrounding metadata kept — by a
 * {@link BlobLinkRef}, the custom `external_blob` object. Nothing else changes:
 * existing remote URLs and file URIs were never extracted and pass through, and
 * no field is renamed to `source.url`, `file_url`, `fileUri` or `uri`, because
 * `external_blob` is defined by this contract alone and not by any model API
 * schema.
 *
 *   - The projection is a `structuredClone` copy, never the caller's body. The
 *     body's refs have to survive this call: the upstream request still streams
 *     the original inline base64 from the local blobs (§5.3, §5.4), so replacing
 *     them in place would destroy the payloads and could put a link object — or a
 *     replacement URL — in front of a model API, which §5.8 forbids.
 *   - `sha256` and `size` are the ref's own `hash` and `size`, i.e. the hash of
 *     the *stored base64 text* and that text's length, so the auth service can
 *     fetch the object and verify it byte for byte before deciding.
 *   - `media_type` is the field's own answer first (the `data:` prefix the ref
 *     kept), then the media-type sibling the schema puts beside the payload, and
 *     `null` when neither exists — Chat Completions `input_audio` states no media
 *     type, and reading one out of its `format` field would be a guess.
 *   - A ref with no link refuses the whole projection, and so does a link that is
 *     not an HTTPS URL. §5.8: "Upload, URL-generation, auth-fetch, or
 *     verification failure fails auth explicitly and prevents the upstream call.
 *     Never silently fall back to an empty binary field or send a broken link."
 *
 * The link source is a map of blob hash to signed download URL, so this module
 * stays synchronous and pure and the upload is a separate, plainly ordered step
 * (§5.8 streams each L2 blob to the object store; that caller owns the network
 * I/O and the leases, and deliberately does not delete the objects afterwards —
 * see `external-upload.ts`). The map is keyed by hash because two refs to one
 * payload are one stored object, and the caller chooses its key set: §5.2's
 * extraction names the blobs *this* request leased, where walking the body would
 * also find a client-forged ref and upload a blob the request never owned.
 *
 * Wired at the §5.3 shape-2 send boundary in `src/index.ts`, from the
 * still-extracted body *before* the rehydration — the rehydration is what leaves
 * `bodyText` with no refs at all. The deferred `doAuthRequest` then sends this
 * projection text where it used to send the rehydrated body.
 */

import { assertRefShape, isBlobRef, type BlobRef } from './blob-refs.js';
import { ClaudeProxyError } from './errors.js';

/** An auth projection could not be built from the body's refs. */
export class AuthProjectionError extends ClaudeProxyError {
  constructor(message: string) {
    super(message, 500, 'processing_error');
    this.name = 'AuthProjectionError';
  }
}

/**
 * What an inline payload becomes in the auth request (§5.8): a small custom
 * object defined only by the proxy↔auth contract, and versioned with it.
 */
export interface BlobLinkRef {
  type: 'external_blob';
  /** Short-lived signed download URL on the HTTPS object store. */
  url: string;
  /** sha256 of the stored base64 text, i.e. the ref's blob hash. */
  sha256: string;
  /** That text's length in bytes. */
  size: number;
  /** The payload's media type, `null` when the field states none. */
  media_type: string | null;
  /** How the object store holds the payload. */
  encoding: 'base64';
}

/** What the projection replaced, mirroring `InlineExtraction`. */
export interface AuthProjection<T> {
  /** A deep copy of the body, each ref replaced by its link object. */
  body: T;
  /** How many refs became link objects. */
  refs: number;
  /**
   * Bytes the auth request does not carry: the stored payload length of every
   * projected ref. This is the auth-request relief, not disk usage — two
   * identical payloads are two links over one uploaded object.
   */
  bytes: number;
}

/**
 * Build the auth projection of `body`, leaving `body` untouched.
 *
 * `links` maps each blob hash to its signed download URL.
 *
 * Throws a `BlobStoreError` on a ref whose shape is wrong (the same refusal
 * `rehydrateInlineBlobs` and the §5.3 shape-3 serializer make, from the shared
 * `assertRefShape`) and an {@link AuthProjectionError} when a ref has no link or
 * its link is not usable — before returning anything, so a caller can never send
 * a projection that is missing a payload's bytes.
 */
export function buildAuthProjection<T>(body: T, links: ReadonlyMap<string, string>): AuthProjection<T> {
  const projection = structuredClone(body);
  const tally = { refs: 0, bytes: 0 };
  replaceRefs(projection, links, tally);
  return { body: projection, refs: tally.refs, bytes: tally.bytes };
}

/** Every ref in `node` replaced by its link object, counted into `tally`. */
function replaceRefs(node: unknown, links: ReadonlyMap<string, string>, tally: Tally): void {
  if (typeof node !== 'object' || node === null) return;

  // Arrays and objects in one loop: `Object.entries` gives an array's indices,
  // and a hole holds no ref to find.
  const holder = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(holder)) {
    if (isBlobRef(value)) {
      holder[key] = blobLink(value, holder, links);
      tally.refs += 1;
      tally.bytes += value.size;
      continue;
    }
    replaceRefs(value, links, tally);
  }
}

/** How much the projection has replaced so far. */
interface Tally {
  refs: number;
  bytes: number;
}

/** One ref's §5.8 link object, or a thrown refusal. */
function blobLink(ref: BlobRef, holder: Record<string, unknown>, links: ReadonlyMap<string, string>): BlobLinkRef {
  // Shape first: a malformed ref must not reach the caller's upload map with a
  // `size` the link would state as fact.
  assertRefShape(ref);

  const url = links.get(ref.hash);
  if (typeof url !== 'string' || url === '') {
    throw new AuthProjectionError(
      `[spool] no external link for blob ${ref.hash}: external upload is configured, `
      + 'so the auth request cannot be sent without one',
    );
  }
  assertHttpsUrl(url, ref.hash);

  return {
    type: 'external_blob',
    url,
    sha256: ref.hash,
    size: ref.size,
    media_type: mediaTypeFor(ref, holder),
    encoding: 'base64',
  };
}

/**
 * The media type the link states: the ref's kept `data:` prefix when the field
 * was a data URL, otherwise the media-type sibling the schema puts next to the
 * payload, otherwise nothing.
 */
function mediaTypeFor(ref: BlobRef, holder: Record<string, unknown>): string | null {
  return mediaTypeFromPrefix(ref.prefix) ?? siblingMediaType(holder) ?? null;
}

/** `data:image/png;base64,` → `image/png`; `''` or `data:;base64,` → nothing. */
function mediaTypeFromPrefix(prefix: string): string | undefined {
  const type = /^data:([^;,]*)/i.exec(prefix)?.[1].trim();
  return type ? type : undefined;
}

/**
 * The media-type spellings the allowlisted positions use: Claude's and the
 * Responses inline skill's `source.media_type`, and Gemini's `mime_type` or
 * `mimeType` beside `data`.
 */
const MEDIA_TYPE_KEYS = ['media_type', 'mime_type', 'mimeType'] as const;

function siblingMediaType(holder: Record<string, unknown>): string | undefined {
  for (const key of MEDIA_TYPE_KEYS) {
    const value = holder[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/**
 * §5.8 requires an HTTPS object store reachable by the auth service, with
 * short-lived signed download URLs. Enforced where the link is built, so a
 * misconfigured uploader cannot put a plaintext or unusable URL into an auth
 * request.
 *
 * The URL itself is never echoed into an error message: it is a signed URL and
 * carries its own credentials, and §5.8 redacts those from logs.
 */
function assertHttpsUrl(url: string, hash: string): void {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new AuthProjectionError(`[spool] the external link for blob ${hash} is not a URL`);
  }
  if (protocol !== 'https:') {
    throw new AuthProjectionError(
      `[spool] the external link for blob ${hash} uses ${protocol}, not https:`,
    );
  }
}
