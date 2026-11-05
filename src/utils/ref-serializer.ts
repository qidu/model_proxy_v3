/**
 * SSD spool — the §5.3 shape 3 serializer: a ref-bearing body streamed back out
 * as ordinary JSON, with an exact `Content-Length`.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md (§5.3, §5.4).
 *
 * Shape 3 is the send path that keeps refs *across* the send boundary. Instead of
 * expanding the body into one string (shape 2 — `rehydrateInlineBlobs` in
 * `blob-refs.ts`) the handler streams the JSON out and reads each blob's base64
 * from L2 in chunks at the exact position its ref occupies. Peak RAM at the send
 * is then the skeleton plus one chunk per blob rather than a whole expanded body.
 *
 *   - Shapes 1 and 3 fix the slow-upstream request-send window; shape 2 does not,
 *     because the expanded body is alive for the length of the send.
 *   - A live blob's L2 file is its source of truth (§5.4), so a chunked read is a
 *     complete read, not a cache-miss fallback — no L1 promotion is needed just
 *     to send a payload once.
 *
 * Exactness: `contentLength` is the skeleton's UTF-8 bytes plus each ref's
 * recorded `size`, measured without reading a single blob. That arithmetic is
 * only sound because extraction refuses to make a ref out of a payload JSON would
 * escape (`JSON_VERBATIM_PAYLOAD` in `blob-refs.ts`), so a ref costs
 * `JSON.stringify(prefix)` bytes plus `size` — exactly what the expanded field
 * would have cost. Nothing here forwards a stale length: the whole value is
 * walked once before the first byte is emitted, so a malformed ref or a cycle
 * refuses the send while refusing is still free, and the streaming walk asserts
 * the bytes it wrote against the length it declared.
 *
 * Emission is `JSON.stringify`'s, not a reimplementation of it: `isBlobRef` is
 * checked first (a ref is a leaf, never recursed into), and every key and every
 * non-ref value is stringified by the builtin — so numbers (`-0`, `NaN`,
 * `Infinity`), string escaping and null are the builtin's answers. Key order is
 * `Object.keys` order, which is the OrdinaryOwnPropertyKeys order
 * `JSON.stringify` uses; a `toJSON` hook is applied exactly as the builtin applies
 * it (once per property, before the undefined/function/symbol test, which decides
 * that an object omits the key while an array writes `null`). A cycle is refused
 * with a named error instead of the unbounded recursion that ends in a cryptic
 * `RangeError`. The tests assert all of this by comparing against
 * `JSON.stringify`'s own output for the same body.
 *
 * A caller must send the returned stream with the returned `contentLength` and
 * `duplex: 'half'` — this repo's streamed-egress convention
 * (`src/handlers/passthrough.ts:271`) — and owns the refs' leases like any other
 * holder of the body (§5.5).
 *
 * Callers: the native `/v1/messages` send (`src/handlers/claude.ts`), the native
 * `/v1/chat/completions` send (`src/handlers/chat-completions.ts`), the
 * `/v1/responses` passthrough (`src/handlers/responses.ts`) and the two converted
 * Claude-format sends in `src/handlers/messages.ts` — the OpenAI Completions one
 * and the OpenAI Responses one, whose already-OpenAI branch streams a body it did
 * not convert at all. Each decides once per request whether the body it is about to
 * send still carries refs, and streams only if it does; a converter that re-encoded
 * or dropped a payload leaves no ref behind, and that send takes the ordinary
 * string or attempt-spill path. No send expands refs to reach this decision any
 * more: the shape-2 `rehydrateInlineBlobs` calls left in `src/handlers/` serve the
 * two `sdk://` branches, which answer 501 before their handler reads the body.
 *
 * One caller is not a request send: §5.7's SSE event framer (`spool-events.ts`)
 * uses this serializer to write a parsed event back out around its extracted
 * payload, passing the per-response scratch store as `readChunks` — the same
 * skeleton-plus-chunks emission, against the store that holds the payload. The
 * other is §5.7's converted-response egress (`spool-response.ts`), which is the
 * same emission without the event framing, and which uses the `onDrained` hook
 * below to delete the scratch store once the client has taken the last byte.
 */

import { BLOB_STREAM_CHUNK_BYTES, readBlobChunks } from './blob-store.js';
import { assertRefShape, isBlobRef, type BlobRef } from './blob-refs.js';
import { ClaudeProxyError } from './errors.js';

/** A ref-bearing body could not be turned into JSON body bytes. */
export class RefSerializerError extends ClaudeProxyError {
  constructor(message: string) {
    super(message, 500, 'processing_error');
    this.name = 'RefSerializerError';
  }
}

/** A ref-bearing body, ready to hand to `fetch`. */
export interface RefAwareJsonBody {
  /** The JSON text, reading each blob from L2 as its ref is reached. */
  body: ReadableStream<Uint8Array>;
  /** The exact byte count of that text, from skeleton bytes plus blob sizes. */
  contentLength: number;
}

/** One step of the emitted JSON: literal text, or a blob read at this position. */
type Event = { text: string } | { ref: BlobRef };

/**
 * Serialize a ref-bearing body as JSON bytes without expanding its blobs.
 *
 * Throws — before reading any blob and before creating the stream — a
 * {@link RefSerializerError} when the value cannot be a request body, when it
 * contains a cycle or a BigInt, and a `BlobStoreError` when it carries a ref whose
 * shape is wrong (the same refusal `rehydrateInlineBlobs` makes, from the shared
 * `assertRefShape`). A body whose bytes turn out not to match the length this
 * declared errors the stream rather than closing it short.
 */
export function createRefAwareJsonBody(
  value: unknown,
  options: {
    chunkBytes?: number;
    /**
     * Where a ref's payload bytes come from, as bounded chunks. Defaults to the
     * cross-request cache's L2 files; §5.7's response egress passes its own
     * per-response scratch store instead, so a response payload is read from the
     * store that holds it rather than looked up in the cache that must not.
     */
    readChunks?: (hash: string, chunkBytes: number) => AsyncIterable<Uint8Array>;
    /**
     * Runs once on every terminal path of the returned stream — the last byte
     * handed over, the consumer cancelling it, a blob read failing or the body
     * coming up short. Always after the stream's read handle is closed, so it is
     * where a caller that owns the refs' leases gives them back (§5.5): §5.7's
     * converted-response egress releases the refs and deletes its scratch store
     * here, when nothing can still be reading the payloads.
     */
    onDrained?: () => Promise<void>;
  } = {},
): RefAwareJsonBody {
  const chunkBytes = options.chunkBytes ?? BLOB_STREAM_CHUNK_BYTES;
  const readChunks = options.readChunks ?? readBlobChunks;
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) {
    throw new RefSerializerError(`[spool] blob chunk size must be a positive integer, got ${chunkBytes}`);
  }

  // `JSON.stringify` applies `toJSON` to the root too, and the root has to be
  // something that can be a request body: a scalar body would be a caller bug,
  // and `null` is exactly what an omitted root would silently become.
  const root = withToJson(value);
  if (typeof root !== 'object' || root === null) {
    throw new RefSerializerError(`[spool] a request body must be a JSON object or array, got ${typeof root}`);
  }

  // First walk: measure and validate, retaining nothing. This is where a ref that
  // cannot be trusted or a cycle is caught — before the headers, and therefore
  // before the upstream, have seen anything.
  let contentLength = 0;
  for (const event of emitValue(root, new Set<object>())) {
    contentLength += 'ref' in event ? event.ref.size : Buffer.byteLength(event.text, 'utf8');
  }

  // Second walk: the same events, turned into bytes as the consumer asks for
  // them. Two walks rather than a retained list of events, so the skeleton is
  // never materialized — that is the point of shape 3.
  let written = 0;
  const chunks = streamEvents(emitValue(root, new Set<object>()), chunkBytes, (bytes) => {
    written += bytes;
  }, readChunks);

  // One path per terminal state, and only one of them runs: the hook is what
  // gives a caller's leases back, so running it twice would double-release them.
  let drained = false;
  const drain = async (): Promise<void> => {
    if (drained) return;
    drained = true;
    // Closes the read handle the generator holds for the ref it was reading —
    // the ordering §5.5 asks for, so the hook's deletions hit no open handle. A
    // generator that already ended (or threw) is a no-op here.
    await chunks.return(undefined);
    await options.onDrained?.();
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // One event per pull: the consumer's demand is the backpressure (§5.7).
      let next: IteratorResult<Uint8Array>;
      try {
        next = await chunks.next();
      } catch (error) {
        await drain();
        controller.error(error);
        return;
      }
      if (!next.done) {
        controller.enqueue(next.value);
        return;
      }
      if (written !== contentLength) {
        // The declared length is already promised to the upstream; a short body
        // must not be passed off as the body it claimed to be (repo rule #8).
        await drain();
        controller.error(
          new RefSerializerError(`[spool] emitted ${written} of ${contentLength} declared body bytes`),
        );
        return;
      }
      // The walk ended, so the generator's `for await` has closed the last
      // handle already: only the leases are left to give back.
      await drain();
      controller.close();
    },
    async cancel() {
      await drain();
    },
  });

  return { body, contentLength };
}

/**
 * Every event of the JSON text of `value`, in emission order.
 *
 * A generator so both walks share one traversal and neither retains it. `node`
 * arrives with `toJSON` already applied by its parent — the same single
 * application per position that `JSON.stringify` performs.
 */
function* emitValue(node: unknown, ancestors: Set<object>): Generator<Event> {
  if (isBlobRef(node)) {
    // The field value is `prefix + payload`, so emit the prefix as JSON text
    // (escaped by the builtin, minus the two quotes it adds) and the payload as
    // raw bytes — which extraction guarantees needs no escaping.
    assertRefShape(node);
    const quoted = JSON.stringify(node.prefix);
    yield { text: `"${quoted.slice(1, -1)}` };
    yield { ref: node };
    yield { text: '"' };
    return;
  }

  if (typeof node === 'object' && node !== null) {
    if (ancestors.has(node)) {
      throw new RefSerializerError('[spool] cannot serialize a body that contains a cycle');
    }
    ancestors.add(node);

    if (Array.isArray(node)) {
      yield { text: '[' };
      for (let index = 0; index < node.length; index++) {
        if (index > 0) yield { text: ',' };
        const item = withToJson(node[index]);
        // A hole and a value JSON cannot represent are both `null` in an array.
        if (hasNoJsonText(item)) yield { text: 'null' };
        else yield* emitValue(item, ancestors);
      }
      yield { text: ']' };
    } else {
      yield { text: '{' };
      let emitted = 0;
      for (const key of Object.keys(node)) {
        const member = withToJson((node as Record<string, unknown>)[key]);
        if (hasNoJsonText(member)) continue; // an object omits such a key entirely
        if (emitted > 0) yield { text: ',' };
        yield { text: `${JSON.stringify(key)}:` };
        yield* emitValue(member, ancestors);
        emitted += 1;
      }
      yield { text: '}' };
    }

    ancestors.delete(node);
    return;
  }

  if (typeof node === 'bigint') {
    throw new RefSerializerError('[spool] a BigInt has no JSON form and cannot be sent');
  }
  // A string, number or boolean: stringified by the builtin, so escaping, `-0`,
  // `NaN` and `Infinity` are its answers rather than a reimplementation. Every
  // caller filtered out the values with no JSON text, which is why this is total.
  yield { text: JSON.stringify(node) };
}

/**
 * `value` with its `toJSON` hook applied, as `JSON.stringify` applies it before
 * it decides anything else about a value.
 */
function withToJson(value: unknown): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'bigint')) return value;
  const method = (value as { toJSON?: unknown }).toJSON;
  if (typeof method !== 'function') return value;
  return (method as () => unknown).call(value);
}

/**
 * True when JSON has no text for `value`: `JSON.stringify` returns `undefined`
 * for it, which an object answers by omitting the key and an array by writing
 * `null`.
 */
function hasNoJsonText(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

/**
 * Turn the event walk into body bytes: text verbatim, and each ref read from L2
 * in chunks of at most `chunkBytes`.
 *
 * A ref that streams a different number of bytes than it records is refused after
 * the fact: the difference means the ref and the blob disagree about the payload,
 * and continuing would hand the upstream a body cut short or padded.
 */
async function* streamEvents(
  events: Generator<Event>,
  chunkBytes: number,
  countBytes: (bytes: number) => void,
  readChunks: (hash: string, chunkBytes: number) => AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  for (const event of events) {
    if ('text' in event) {
      const bytes = Buffer.from(event.text, 'utf8');
      countBytes(bytes.byteLength);
      yield bytes;
      continue;
    }

    let streamed = 0;
    for await (const chunk of readChunks(event.ref.hash, chunkBytes)) {
      streamed += chunk.byteLength;
      countBytes(chunk.byteLength);
      yield chunk;
    }
    if (streamed !== event.ref.size) {
      throw new RefSerializerError(
        `[spool] blob ${event.ref.hash} streamed ${streamed} bytes but its ref records ${event.ref.size}`,
      );
    }
  }
}
