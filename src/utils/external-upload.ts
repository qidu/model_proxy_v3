/**
 * SSD spool — the §5.8 external upload: streaming L2 blobs to the auth-side store.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md (§5.8, §10).
 *
 * When `[spool] external_upload_url` is configured, the auth request no longer
 * carries inline binary: each blob left in the body is uploaded here, and the
 * signed download URL that comes back is what `buildAuthProjection` puts into
 * `auth_with_body` as an `external_blob` link. The upstream model request is
 * untouched — it still streams the original base64 from the local blobs (§5.3,
 * §5.4). Nothing in this module produces a link for the upstream side.
 *
 * The upload is opt-in twice over: `[spool] enabled` makes the blobs exist, and
 * `external_upload_url` decides that user binary may leave this host at all.
 * With no uploader configured this module refuses loudly instead of returning an
 * empty map: §5.8 keeps the full-body auth path in that case, and a caller that
 * reached here anyway is misconfigured, not silently link-less.
 *
 * The wire contract, in full (the endpoint is the auth service's, and both
 * halves are versioned with the `external_blob` link object):
 *
 *   - One `PUT` per distinct blob to `uploadUrl`. Two refs to one payload are
 *     one stored object (§5.4), so a repeated hash uploads once.
 *   - The body is the stored base64 text itself, streamed in 64 KiB chunks, with
 *     an exact `Content-Length`: no JSON envelope, no re-encoding, and the
 *     payload is never buffered whole. `X-Blob-Sha256` and `X-Blob-Size` state
 *     what the endpoint is receiving so it can verify on ingest, and
 *     `Authorization: Bearer` is sent only when a token is configured.
 *   - The answer is `{ url, sha256, size, expires_in }` — a JSON object. Every
 *     field is checked before the URL is returned: `sha256` and `size` must be
 *     the ones uploaded (hash/size verification), `url` must be an absolute
 *     HTTPS URL with no embedded credentials, and `expires_in` must reach
 *     `external_url_min_lifetime_s`. §5.8: "Never silently fall back to an empty
 *     binary field or send a broken link."
 *
 * Redaction is a property of this module, not of its caller. The signed URL, the
 * bearer token and the configured endpoint are never echoed into an error
 * message or a log line — a signed URL carries its own credentials, and errors
 * here end up in logs. An endpoint's error body is not echoed either, for the
 * same reason, and transport failures go through `classifyTransportError`, whose
 * messages are already sanitized of hostnames and ports.
 *
 * The proxy does not delete external objects after the auth decision. That is a
 * decision taken with the user (2026-11-04), and it is a deliberate divergence
 * from §5.8's "best-effort delete external objects after the auth decision": the
 * operator configures the store's lifecycle TTL instead, and that TTL alone
 * bounds every object's lifetime, not just crash leftovers. External objects are
 * still never request recovery state, never reused as a proxy cache, and never
 * resumed after a restart — nothing here is persisted.
 *
 * Leases belong to the caller (§5.5). This module reads blobs and never retains
 * or releases one: a held lease keeps `refs > 0`, and the idle sweep only
 * expires entries with no refs, so §5.8's "renew the blob's existing lease
 * throughout upload, auth fetch, and the subsequent upstream send" is satisfied
 * by holding it — slow external I/O cannot turn into a TTL deletion.
 *
 * Wired at the §5.3 shape-2 send boundary in `src/index.ts`: it uploads
 * {@link InlineExtraction.blobs} — the request's own distinct leases, taken while
 * the refs still exist in the body — and the request's existing lease hold, not
 * this module, keeps them alive until the upstream send is over.
 */

import { readBlobChunks, type LeasedBlob } from './blob-store.js';
import { ClaudeProxyError, classifyTransportError } from './errors.js';
import { getSpoolConfig, type SpoolExternalUploadConfig } from './spool.js';

/** An external upload could not produce a usable link for a blob. */
export class ExternalUploadError extends ClaudeProxyError {
  constructor(message: string, status: number = 500, type: string = 'processing_error') {
    super(message, status, type);
    this.name = 'ExternalUploadError';
  }
}

/**
 * The ref skeleton an upload needs: identity and length, nothing else.
 *
 * `LeasedBlob` itself satisfies this, and so does a §5.2 extraction ref — §5.8
 * keeps only this much of the request in memory across external network I/O.
 */
export type UploadableBlob = Pick<LeasedBlob, 'hash' | 'size'>;

/**
 * Upload every distinct blob in `blobs`, mapping each hash to its signed URL.
 *
 * The result is exactly what `buildAuthProjection` consumes as `links`, keyed by
 * the ref's own hash. Uploads run one at a time: a bounded number of
 * connections, and a failure stops before the next blob leaves the host.
 *
 * Throws an {@link ExternalUploadError} on any upload, URL, verification or
 * expiry failure, and a `BlobStoreError` for a blob it cannot read — never a
 * partial map, so a caller cannot send an auth request that is missing a link.
 */
export async function uploadBlobsForAuth(
  blobs: ReadonlyArray<UploadableBlob>,
): Promise<ReadonlyMap<string, string>> {
  const upload = requireExternalUpload();

  const sizes = new Map<string, number>();
  for (const blob of blobs) {
    const seen = sizes.get(blob.hash);
    if (seen !== undefined && seen !== blob.size) {
      // Two answers for one object: a stored blob has one length, so this is a
      // caller bug and not a blob to upload at either size.
      throw new ExternalUploadError(
        `[spool] external upload of blob ${blob.hash} was asked for at sizes ${seen} and ${blob.size}`,
      );
    }
    sizes.set(blob.hash, blob.size);
  }

  const links = new Map<string, string>();
  for (const [hash, size] of sizes) {
    links.set(hash, await uploadBlob(hash, size, upload));
  }
  return links;
}

/** The configured uploader, or a refusal — never a silent no-op. */
function requireExternalUpload(): SpoolExternalUploadConfig {
  const upload = getSpoolConfig().externalUpload;
  if (upload === null) {
    throw new ExternalUploadError(
      '[spool] external upload was requested but [spool] external_upload_url is not configured; '
      + 'an unconfigured uploader keeps the full-body auth path instead',
    );
  }
  return upload;
}

/** One blob uploaded, verified, and turned into its signed URL. */
async function uploadBlob(
  hash: string,
  size: number,
  upload: SpoolExternalUploadConfig,
): Promise<string> {
  if (!Number.isInteger(size) || size <= 0) {
    throw new ExternalUploadError(`[spool] blob ${hash} has no uploadable size, got: ${String(size)}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), upload.uploadTimeoutMs);
  // The timer must not hold the process open once the upload settles.
  timer.unref();

  try {
    const response = await fetch(upload.uploadUrl, {
      method: 'PUT',
      headers: uploadHeaders(hash, size, upload.token),
      body: await blobBody(hash, size),
      // A streamed request body needs `duplex: 'half'` (repo convention:
      // src/handlers/passthrough.ts:267).
      duplex: 'half',
      signal: controller.signal,
    } as RequestInit);

    const receipt = await readReceipt(response, hash);
    return signedUrl(receipt, hash, size, upload);
  } catch (error) {
    // Our own refusals (and the blob store's) already say what went wrong and
    // must not be re-labelled as a transport failure.
    if (error instanceof ClaudeProxyError) throw error;
    throw uploadFailure(hash, error, controller.signal.aborted, upload.uploadTimeoutMs);
  } finally {
    clearTimeout(timer);
  }
}

/** What the endpoint is told about the bytes it is about to receive. */
function uploadHeaders(hash: string, size: number, token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    // Exact, because the body is the stored base64 text and nothing re-encodes
    // it: the endpoint can reject a truncated upload before hashing it.
    'content-length': String(size),
    'x-blob-sha256': hash,
    'x-blob-size': String(size),
  };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return headers;
}

/**
 * The stored base64 text as a request body.
 *
 * The opening chunk is pulled before the request is opened, not on the
 * consumer's first demand: that is where `readBlobChunks` checks the hash is
 * indexed and unexpired, the file opens, and its length is the one the index
 * states — so a blob that cannot be read fails the upload before any byte, or
 * anything about the request, leaves the host.
 *
 * Backpressure comes from `pull`: one 64 KiB chunk per unit of consumer demand
 * (§5.7's convention). A short stream is an error rather than a short body
 * passed off as the declared length, and `cancel` closes the L2 handle the
 * generator holds.
 */
async function blobBody(hash: string, size: number): Promise<ReadableStream<Uint8Array>> {
  const chunks = readBlobChunks(hash);
  const opening = await chunks.next();
  let pending: Uint8Array | null = opening.done ? null : opening.value;
  let written = pending === null ? 0 : pending.byteLength;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pending !== null) {
        controller.enqueue(pending);
        pending = null;
        return;
      }
      let next: IteratorResult<Uint8Array>;
      try {
        next = await chunks.next();
      } catch (error) {
        controller.error(error);
        return;
      }
      if (!next.done) {
        written += next.value.byteLength;
        controller.enqueue(next.value);
        return;
      }
      if (written !== size) {
        controller.error(
          new ExternalUploadError(`[spool] blob ${hash} streamed ${written} of ${size} declared bytes`),
        );
        return;
      }
      controller.close();
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}

/** The endpoint's JSON answer, or a refusal that does not quote its body. */
async function readReceipt(response: Response, hash: string): Promise<unknown> {
  if (!response.ok) {
    // The body is not echoed: it is the endpoint's own text and may quote the
    // signed URL, which §5.8 redacts.
    throw new ExternalUploadError(
      `[spool] external upload of blob ${hash} answered HTTP ${response.status}`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new ExternalUploadError(`[spool] external upload of blob ${hash} did not answer JSON`);
  }
}

/**
 * The link the receipt states, once every field has been checked against what
 * was uploaded.
 *
 * The URL is validated here rather than left to the projection: a link that
 * cannot be used must fail the upload, before any auth request is built (§5.8).
 */
function signedUrl(
  receipt: unknown,
  hash: string,
  size: number,
  upload: SpoolExternalUploadConfig,
): string {
  if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) {
    throw new ExternalUploadError(
      `[spool] external upload of blob ${hash} answered ${Array.isArray(receipt) ? 'an array' : typeof receipt} instead of a link object`,
    );
  }
  const record = receipt as Record<string, unknown>;

  const url = record.url;
  if (typeof url !== 'string' || url.trim() === '') {
    throw new ExternalUploadError(`[spool] external upload of blob ${hash} answered no url`);
  }
  const link = url.trim();
  assertSignedUrl(link, hash);

  // Hash and size verification (§5.8): the store must hold the bytes that were
  // sent, not whichever object it happens to name. The hash is hex, so case is
  // the endpoint's, not a difference in content.
  const echoed = record.sha256;
  if (typeof echoed !== 'string' || echoed.toLowerCase() !== hash.toLowerCase()) {
    throw new ExternalUploadError(
      `[spool] external upload of blob ${hash} stored a different object: it answered sha256 ${String(echoed)}`,
    );
  }
  if (record.size !== size) {
    throw new ExternalUploadError(
      `[spool] external upload of blob ${hash} stored ${String(record.size)} of ${size} bytes`,
    );
  }

  // §5.8 needs a short-lived URL that outlives the auth decision. The proxy
  // cannot parse every store's URL for an expiry, so it takes the endpoint's
  // `expires_in` as stated — and refuses one below the configured floor rather
  // than trusting the endpoint to have meant a long lifetime.
  const lifetime = record.expires_in;
  if (
    typeof lifetime !== 'number'
    || !Number.isInteger(lifetime)
    || lifetime < upload.urlMinLifetimeSeconds
  ) {
    throw new ExternalUploadError(
      `[spool] external upload of blob ${hash} answered a link lifetime of ${String(lifetime)} s, `
      + `below the ${upload.urlMinLifetimeSeconds} s minimum`,
    );
  }

  return link;
}

/**
 * §5.8 requires an HTTPS object store reachable by the auth service.
 *
 * Absolute, `https:`, and no embedded userinfo — a signed URL's own query-string
 * credentials are the mechanism, but userinfo in the authority is a credential
 * the proxy would be passing along unnoticed. The URL itself is never echoed: it
 * is signed, and §5.8 redacts those from logs.
 */
function assertSignedUrl(url: string, hash: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ExternalUploadError(
      `[spool] external upload of blob ${hash} returned a link that is not a URL`,
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new ExternalUploadError(
      `[spool] external upload of blob ${hash} returned a ${parsed.protocol} link, not https:`,
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ExternalUploadError(
      `[spool] external upload of blob ${hash} returned a link with embedded credentials`,
    );
  }
}

/**
 * A thrown upload, named by blob and kind.
 *
 * `timedOut` is ours — the abort signal on this request has one source, the
 * per-blob timer — so it can say how long was allowed. Everything else goes
 * through `classifyTransportError` so a raw `fetch` message cannot carry a
 * hostname or port into the log.
 */
function uploadFailure(
  hash: string,
  error: unknown,
  timedOut: boolean,
  timeoutMs: number,
): ExternalUploadError {
  if (timedOut) {
    return new ExternalUploadError(
      `[spool] external upload of blob ${hash} timed out after ${timeoutMs} ms`,
      504,
      'upstream_timeout',
    );
  }
  const classified = classifyTransportError(error);
  if (classified !== null) {
    return new ExternalUploadError(
      `[spool] external upload of blob ${hash} failed: ${classified.message}`,
      classified.status,
      classified.type,
    );
  }
  return new ExternalUploadError(
    `[spool] external upload of blob ${hash} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}
