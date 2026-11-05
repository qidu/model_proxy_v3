/**
 * SSD spool — Phase 1 ingress: receive request bodies with bounded memory.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md (§5.1, §5.2, §5.5).
 *
 * Replaces "read the whole body into an array of chunks, then re-wrap it" with
 * one backpressured, byte-counted path. The loop itself is shared with §5.7
 * response egress and lives in `spool-body.ts`; this module is the request side
 * of it — the cap that applies (`max_request_bytes`), the spill directory
 * (`requests/`), and the error a breach throws (413 `invalid_request_error`,
 * because here the client really did send too much).
 *
 * Disk use is opt-in (§9.1); see `spool-body.ts` for the shared contract.
 */

import { SpoolBody, receiveSpooledBody } from './spool-body.js';
import { REQUEST_SPILL_SUBDIR, getSpoolConfig } from './spool.js';
import { ClaudeProxyError } from './errors.js';

/** The body exceeded `max_request_bytes`; the caller should answer 413. */
export class SpoolRequestTooLargeError extends ClaudeProxyError {
  constructor(message: string) {
    super(message, 413, 'invalid_request_error');
    this.name = 'SpoolRequestTooLargeError';
  }
}

export { SpoolBody as IngressSpool, SpoolCapacityError, SpoolWriteError, getLiveSpillBytes } from './spool-body.js';

/**
 * Property key for the raw-body ref carried on a `Request`.
 *
 * §5.1: the ref has to survive request reconstruction without header smuggling.
 * `new Request(other, init)` copies neither own properties nor symbols, so every
 * site that rebuilds a request still carrying the raw body must re-attach it
 * with {@link attachIngressSpool} — attaching only in the adapter is what §5.1
 * rules out.
 */
const INGRESS_SPOOL = Symbol.for('model_proxy.ingress_spool');

/** Attach the raw-body spool to a request that carries those raw bytes. */
export function attachIngressSpool(request: Request, spool: SpoolBody): void {
  (request as unknown as Record<symbol, SpoolBody>)[INGRESS_SPOOL] = spool;
}

/** The raw-body spool attached to a request, or undefined when there is none. */
export function getIngressSpool(request: Request): SpoolBody | undefined {
  return (request as unknown as Record<symbol, SpoolBody | undefined>)[INGRESS_SPOOL];
}

/**
 * Read a request body as text: the raw spool's bytes when a ref is attached,
 * otherwise the request's own body (§5.2 — `await request.text()` becomes this).
 */
export async function readIngressSpoolText(request: Request): Promise<string> {
  const spool = getIngressSpool(request);
  return spool ? await spool.readText() : await request.text();
}

export interface IngressSpoolOptions {
  /**
   * Declared `Content-Length`, when the client sent one. Used only to reject
   * early and to decide whether to spill from the first byte; the byte counter
   * enforces `max_request_bytes` whatever this says.
   */
  declaredLength?: number | null;
}

/**
 * Receive a request body, spilling to disk when the configured threshold is
 * crossed. Throws {@link SpoolRequestTooLargeError} past `max_request_bytes`,
 * {@link SpoolCapacityError} when the live spill budget is exhausted, and
 * {@link SpoolWriteError} when the file cannot be written; every failure path
 * removes the partial file and returns its reservation before rethrowing.
 */
export async function receiveIngressBody(
  body: ReadableStream<Uint8Array> | null | undefined,
  options: IngressSpoolOptions = {},
): Promise<SpoolBody> {
  return await receiveSpooledBody(body, {
    subdir: REQUEST_SPILL_SUBDIR,
    filePrefix: 'req-',
    maxBytes: getSpoolConfig().maxRequestBytes,
    bodyLabel: 'Request',
    TooLargeError: SpoolRequestTooLargeError,
    declaredLength: options.declaredLength ?? null,
  });
}
