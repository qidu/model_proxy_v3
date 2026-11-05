/**
 * SSD spool — Phase 2 egress: receive an upstream response body with bounded
 * memory.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md (§5.7, §9.5).
 *
 * §5.7 asks of a response body exactly what §5.1 asks of a request body: at or
 * below `threshold_bytes` stay in memory, above it stream to a per-response
 * spill while counting bytes — never `response.clone().text()`, never a second
 * copy. The loop, the ledger, and the spill-file plumbing are shared with
 * ingress (`spool-body.ts`); this module is the response side of it — the cap
 * that applies (`max_response_bytes`, per finite body or event), the spill
 * directory (`responses/`), and the error a breach throws.
 *
 * A body past `max_response_bytes` is a spool-side failure, not a client error:
 * the request was within its limits, so answering 413 `invalid_request_error`
 * would be a false report (repo rule #8). It is mapped the way every other spool
 * failure in this repo is — 500 `processing_error`. §5.7 pairs a cap breach with
 * a disk failure for that reason, and requires the upstream body to be cancelled
 * rather than the response silently truncated; `receiveSpooledBody` does both.
 *
 * The identity shape is wired: `src/handlers/passthrough.ts` receives the body
 * here and forwards {@link SpoolBody.readStream} to the client, so
 * `threshold_bytes` and `max_response_bytes` are enforced on the non-SSE
 * passthrough response path. The converted shape is
 * {@link createConvertedResponseBody}: a handler that had to parse the body to
 * convert it hands the parsed value here, which extracts §5.7's allowlisted
 * payloads into a per-response scratch store and streams the small transformed
 * skeleton plus blob chunks to the client. §5.7's SSE path — per-event framing
 * and spill, with `max_response_bytes` per event — lives in `spool-events.ts`,
 * which reuses `receiveSpooledBody` once per event and so shares this error; its
 * caller is `streamResponseEvents`, wrapped around both SSE egresses in
 * `src/index.ts` and `src/handlers/passthrough.ts`. The attempt loop's JSON
 * stats read (`src/index.ts`) uses this module too: one bounded receive, one
 * parse, and the client's copy streamed from that same spool — never a
 * `response.clone()`. {@link receiveJsonResponse} is the converted egress's
 * receive: the handlers that must parse the body to convert it (`/v1/messages`,
 * `/v1/chat/completions`, and `openai.ts`'s cross-mode egresses for a Gemini
 * client, `responses.ts`'s four converting readers) get one bounded receive, one
 * parse, and the spill back before the client is answered. Its primitive is
 * {@link withResponseText}, which the small endpoints' own readers use
 * (`embeddings.ts`, `token-counting.ts`, and `decision.ts`, whose egress is the
 * upstream body verbatim).
 */

import { ClaudeProxyError } from './errors.js';
import { logPipelineStage, type Logger } from './logger.js';
import { admitMaterialization, type AdmissionLease } from './spool-admission.js';
import { extractResponseBlobs, releaseExtractedBlobs, type InlineExtraction } from './blob-refs.js';
import { createRefAwareJsonBody } from './ref-serializer.js';
import { RESPONSE_BLOB_SCOPE, ResponseBlobStore } from './response-blobs.js';
import { SpoolBody, receiveSpooledBody } from './spool-body.js';
import { RESPONSE_SPILL_SUBDIR, getSpoolConfig } from './spool.js';

/** The upstream body exceeded `max_response_bytes`; fail explicitly, never truncate. */
export class SpoolResponseTooLargeError extends ClaudeProxyError {
  constructor(message: string) {
    super(message, 500, 'processing_error');
    this.name = 'SpoolResponseTooLargeError';
  }
}

export interface ResponseSpoolOptions {
  /**
   * Declared `Content-Length`, when the upstream response carried one. Used only
   * to reject early and to decide whether to spill from the first byte; the byte
   * counter enforces `max_response_bytes` whatever this says.
   */
  declaredLength?: number | null;
}

/**
 * Receive an upstream response body, spilling to disk when the configured
 * threshold is crossed. Throws {@link SpoolResponseTooLargeError} past
 * `max_response_bytes`, `SpoolCapacityError` when the live spill budget is
 * exhausted, and `SpoolWriteError` when the file cannot be written; every
 * failure path removes the partial file, returns its reservation, cancels the
 * upstream body, and rethrows.
 */
export async function receiveResponseBody(
  body: ReadableStream<Uint8Array> | null | undefined,
  options: ResponseSpoolOptions = {},
): Promise<SpoolBody> {
  return await receiveSpooledBody(body, {
    subdir: RESPONSE_SPILL_SUBDIR,
    filePrefix: 'resp-',
    maxBytes: getSpoolConfig().maxResponseBytes,
    bodyLabel: 'Response',
    TooLargeError: SpoolResponseTooLargeError,
    declaredLength: options.declaredLength ?? null,
  });
}

/**
 * Receive an upstream JSON response body with bounded memory, then parse it
 * (§5.7, §5.9).
 *
 * The non-SSE egresses that must parse the body to convert it used to call
 * `response.text()`, which buffers whatever the upstream sends. Above
 * `threshold_bytes` the bytes now live on this response's spill file while they
 * are received, and `max_response_bytes` bounds the body: a breach cancels the
 * upstream body and fails explicitly instead of leaving a truncated body for
 * `JSON.parse` to trip over. The cap is not gated on `[spool] enabled` — that
 * switch decides whether disk is used, not whether the body is bounded.
 *
 * The caller wants the parsed value, so the body is read once and the spill is
 * released before this returns: what the client reads is the converted body,
 * never these bytes. §5.9 admission is taken around the parse — the
 * materialization that budget exists for — and is a no-op when
 * `max_materialized_body_bytes` is 0. A refusal releases the spill first, so a
 * denied body leaves neither bytes on disk nor a reservation (rule #8).
 *
 * The receive, the lease and both releases are {@link withResponseText}; this is
 * its `JSON.parse` consumer.
 */
export async function receiveJsonResponse<T>(
  response: Response,
  requestId: string,
  logger: Logger,
  stageUrl: string,
  signal?: AbortSignal
): Promise<T> {
  return await withResponseText(response, requestId, logger, stageUrl, (text) => JSON.parse(text) as T, signal);
}

/**
 * Receive an upstream response body into text with bounded memory, and hand that
 * text to `consume` while the §5.9 budget and the spill are still held (§5.7).
 *
 * The primitive behind {@link receiveJsonResponse} and the egresses that cannot
 * use it. A caller that wants the parsed value passes `JSON.parse` and so pays,
 * inside the same lease, for the materialization the §5.9 budget exists for. A
 * caller that must answer *from the text* keeps the text instead: `/decision`
 * returns the upstream body verbatim, and a handler whose own error mapping a
 * helper-thrown `JSON.parse` failure would replace reads it through here.
 *
 * A `consume` that throws — a malformed body, under a caller that maps that to
 * its own status — still releases the lease and the spill first, and a §5.9
 * refusal releases the spill before it propagates, so a failed receive leaves
 * neither bytes on disk nor a reservation (rule #8).
 */
export async function withResponseText<T>(
  response: Response,
  requestId: string,
  logger: Logger,
  stageUrl: string,
  consume: (text: string) => T,
  signal?: AbortSignal
): Promise<T> {
  const received = await receiveResponseBody(response.body);
  let lease: AdmissionLease;
  try {
    lease = await admitMaterialization(received.size, signal);
  } catch (error) {
    await received.release();
    throw error;
  }
  try {
    const text = await received.readText();
    logPipelineStage(logger, requestId, 'upstream-response', stageUrl, text);
    return consume(text);
  } finally {
    lease.release();
    await received.release();
  }
}

/** A converted response body, ready to hand to `new Response` (§5.7). */
export interface ConvertedResponseBody {
  /** The JSON text, or — when payloads were extracted — the skeleton stream. */
  body: string | ReadableStream<Uint8Array>;
  /** Present only for a stream: the exact byte count, for `Content-Length`. */
  contentLength?: number;
}

/**
 * Prepare an already-parsed, already-transformed response for egress (§5.7).
 *
 * `value` is the body the client is to receive, built after every consumer that
 * needs the original bytes — usage, logging, conversion — has run. Extraction
 * replaces each §5.7 allowlisted payload in it with a ref over a scratch store of
 * this response's own, never the cross-request cache, and the returned stream
 * reads those payloads back as the client takes the skeleton: a response carrying
 * a model-generated image costs the client's write pace rather than a second copy
 * in RAM. `contentLength` is exact, so the send declares it.
 *
 * Nothing allowlisted (or `[spool] enabled = false`) returns the ordinary
 * `JSON.stringify` text: extraction is an optimization, so a response without
 * such a payload is byte-for-byte what it was. A payload JSON would have to
 * escape stays inline for the same reason (`skipped` in
 * {@link extractResponseBlobs}'s report) — again unchanged bytes, less relief.
 *
 * The returned stream owns the refs and the store: its last byte, a client
 * cancel and a failed blob read each release the leases and await the deletions,
 * so nothing of this response outlives the write (§5.5). The caller owns the
 * `SpoolBody` it parsed the value from, as with the identity path.
 */
export async function createConvertedResponseBody(value: unknown): Promise<ConvertedResponseBody> {
  if (!getSpoolConfig().enabled) return { body: JSON.stringify(value) };

  const scratch = new ResponseBlobStore(RESPONSE_BLOB_SCOPE);
  // The extraction the catch below has to undo; null while there is none yet,
  // because extraction is all-or-nothing and has already undone its own part.
  let applied: InlineExtraction | null = null;
  try {
    const extraction = await extractResponseBlobs(value, scratch);
    applied = extraction;
    if (extraction.refs === 0) {
      // An empty store holds nothing to keep alive; `dispose` is how it says so.
      await scratch.dispose();
      return { body: JSON.stringify(value) };
    }

    const serialized = createRefAwareJsonBody(value, {
      readChunks: (hash, chunkBytes) => scratch.readChunks(hash, chunkBytes),
      onDrained: () => endResponse(extraction, scratch),
    });
    return { body: serialized.body, contentLength: serialized.contentLength };
  } catch (error) {
    // Nothing has been sent, so this is still a plain failure: give the refs
    // back and delete the files rather than leave them for the startup sweep.
    await endResponse(applied, scratch);
    throw error;
  }
}

/**
 * Release this response's refs and delete its scratch files.
 *
 * Both halves report rather than throw (rule #8, and `dispose` never throws):
 * this runs from a stream's terminal paths, where an exception would replace the
 * outcome the client is already seeing, and from a `catch` that is rethrowing the
 * real reason.
 */
async function endResponse(extraction: InlineExtraction | null, store: ResponseBlobStore): Promise<void> {
  if (extraction) {
    try {
      releaseExtractedBlobs(extraction, store);
    } catch (error) {
      console.warn(`[spool] converted response ref release failed: ${(error as Error).message}`);
    }
  }
  const report = await store.dispose();
  if (report.leaked > 0) {
    console.warn(`[spool] converted response ended with ${report.leaked} scratch lease(s) still held`);
  }
}
