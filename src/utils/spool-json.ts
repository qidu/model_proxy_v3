import { collectBlobRefs } from './blob-refs.js';
import { createRefAwareJsonBody } from './ref-serializer.js';
import { SpoolBody, receiveSpooledBody } from './spool-body.js';
import { SpoolRequestTooLargeError } from './spool-ingress.js';
import { REQUEST_SPILL_SUBDIR, getSpoolConfig } from './spool.js';

/** A JSON body ready to send, without changing the small-body string path. */
export interface JsonEgressBody {
  body: string | ReadableStream<Uint8Array>;
  /** Present only for a stream; fetch cannot infer its length. */
  contentLength?: number;
  /** True when the body was written to the request spill store. */
  spilled: boolean;
}

/** Turn already-final JSON text into its egress body. */
export async function createTextEgressBody(
  text: string,
  filePrefix: string,
): Promise<JsonEgressBody> {
  const config = getSpoolConfig();
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (!config.enabled || byteLength <= config.thresholdBytes) {
    return { body: text, spilled: false };
  }

  const spool: SpoolBody = await receiveSpooledBody(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }, { highWaterMark: 0 }),
    {
      subdir: REQUEST_SPILL_SUBDIR,
      filePrefix,
      maxBytes: config.maxRequestBytes,
      bodyLabel: 'Request',
      TooLargeError: SpoolRequestTooLargeError,
      declaredLength: byteLength,
    },
  );

  return {
    body: spool.readStream(),
    contentLength: spool.size,
    spilled: spool.spilled,
  };
}

/** Serialize and spill an already-final JSON value when it crosses the threshold. */
export async function createJsonEgressBody(
  value: unknown,
  filePrefix: string,
): Promise<JsonEgressBody> {
  return await createTextEgressBody(JSON.stringify(value), filePrefix);
}

/**
 * POST an already-final JSON attempt body: stream refs from L2 when conversion
 * preserved them; otherwise spill a large non-ref body before a slow send.
 */
export async function postJsonWithSpool(
  url: string,
  value: unknown,
  init: {
    headers: Record<string, string>;
    signal?: AbortSignal;
  },
): Promise<Response> {
  const refAware = collectBlobRefs(value).length > 0 ? createRefAwareJsonBody(value) : undefined;
  const egress: JsonEgressBody = refAware
    ? { body: refAware.body, contentLength: refAware.contentLength, spilled: true }
    : await createJsonEgressBody(value, 'att-');
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        ...init.headers,
        ...(egress.contentLength !== undefined ? { 'Content-Length': String(egress.contentLength) } : {}),
      },
      body: egress.body,
      ...(egress.spilled ? { duplex: 'half' } : {}),
      signal: init.signal,
    } as RequestInit);
  } catch (error) {
    if (egress.body instanceof ReadableStream) await egress.body.cancel(error);
    throw error;
  }
}
