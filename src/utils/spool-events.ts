/**
 * SSD spool — Phase 2 egress: frame an SSE stream one event at a time and spill
 * the event that is too large to hold (§5.7).
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md (§5.5, §5.7,
 * §9.5).
 *
 * §5.7 asks three things of an event stream that the body-shaped spool in
 * `spool-response.ts` cannot give it:
 *
 *   - Events are framed one at a time, preserving boundaries and order, and the
 *     whole stream is never accumulated before forwarding (spooling the stream
 *     and then relaying it is rejected in §9.5: it delays ordinary events and
 *     grows disk use with stream duration).
 *   - Only an event past `threshold_bytes` spills, and only while it is being
 *     received. Small events pass through with bounded buffering.
 *   - A slow client pauses event reads from upstream; later events must not pile
 *     up in an unbounded RAM queue.
 *
 * So this is the per-event analogue of {@link receiveResponseBody}: each event is
 * received through the same shared loop (`receiveSpooledBody`) — same ledger,
 * same cap, same cap-breach error as a non-SSE response — and handed out a chunk
 * at a time by {@link SpoolBody.readStream}, which deletes the event's spill once
 * its last byte is written or the client goes away. At most one event exists at
 * a time, so live event spills stay bounded by one event's size rather than by
 * stream length, and the output stream is pull-driven with `highWaterMark: 0`, so
 * a stalled client stops the upstream reads instead of queueing what follows.
 *
 * Nothing here parses an event that did not spill. Comments, keep-alives and
 * non-JSON vendor sentinels stay byte-passthrough. §5.7's other half applies to
 * the event that actually spilled: it is parsed, its allowlisted binary payloads
 * (Gemini response parts, Responses generated images) are written to this event's
 * scratch store and replaced by refs, and the event is written back out as its
 * own text around that payload, with the base64 streamed from disk in chunks. Only
 * that payload's own span of the event text is replaced, so the envelope — `event:`,
 * `id:`, comments, spacing, terminator — and every byte outside the payload are
 * the upstream byte by construction, and a payload that does not survive
 * `JSON.stringify` unchanged is never made into a ref (`JSON_VERBATIM_PAYLOAD`).
 * An event that is not one single-line JSON `data:` payload, or that carries
 * nothing allowlisted, is replayed from its spill unread.
 *
 * The scratch store lives exactly as long as one event: it is created when the
 * event is parsed and disposed when the client has taken the event's last byte,
 * or when either end goes away (§5.7). Each parse takes a §5.9 materialization
 * lease for the event's bytes and gives it back as soon as the payloads are on
 * disk, because the skeleton is all that stays in RAM.
 *
 * Framing is done on bytes rather than on decoded text, so that the concatenation
 * of what the returned stream emits is the upstream byte sequence exactly. A text
 * decode would not survive a payload that is not valid UTF-8, and re-serializing
 * a parsed event would silently drop `event:`/`id:` lines and a `[DONE]`
 * sentinel. Because the blank line is part of an event, a stream that ends
 * without one still forwards its tail, and no byte is ever dropped or duplicated.
 * The extracted event above keeps that promise the same way: the parse is used
 * only to locate one payload, and the bytes on either side of it are copied from
 * the event text rather than written by a serializer.
 *
 * A CRLF-framed stream (`\r\n\r\n`) is not recognized as separate events, which
 * matches the SSE forwarding path this repo already has (`request-transform.ts`
 * and `gemini-streaming.ts` split on `\n\n`): only the stats parser in
 * `dashboard-stats.ts` normalizes CRLF, and it may, because it re-serializes
 * instead of forwarding. A forwarder cannot normalize without changing the bytes
 * it promised to relay.
 *
 * Callers: the attempt loop in `src/index.ts` (before the response consumers, so
 * one event is bounded before any consumer accumulates it) and the `/passthrough/*`
 * SSE branch in `src/handlers/passthrough.ts`, which returns early from the
 * attempt loop and so is not covered by the former. Both frame only when
 * `[spool] enabled = true`: with spooling off there is nothing to spill, and the
 * relay stays the upstream bytes unframed rather than paying a copy per event.
 */

import { extractResponseBlobs, releaseExtractedBlobs, type InlineExtraction } from './blob-refs.js';
import { createRefAwareJsonBody } from './ref-serializer.js';
import { EVENT_BLOB_SCOPE, ResponseBlobStore } from './response-blobs.js';
import { admitMaterialization } from './spool-admission.js';
import { SpoolBody, receiveSpooledBody } from './spool-body.js';
import { SpoolResponseTooLargeError } from './spool-response.js';
import { EVENT_SPILL_SUBDIR, getSpoolConfig } from './spool.js';

/** Byte value of `\n`. */
const LF = 0x0a;

/** Spill file-name prefix for an event, so a leftover file names what wrote it. */
const EVENT_FILE_PREFIX = 'evt-';

/**
 * Index of the `\n` that opens the blank line ending the event, or -1 when this
 * chunk holds no blank line. `from` skips the part of the chunk already scanned.
 */
function findBlankLine(bytes: Uint8Array, from: number): number {
  for (let i = from; i + 1 < bytes.byteLength; i++) {
    if (bytes[i] === LF && bytes[i + 1] === LF) return i;
  }
  return -1;
}

/** Where one event's JSON payload sits inside the event's own text. */
interface EventPayload {
  /** First byte of the payload, past `data:` and the one optional space. */
  start: number;
  /** First byte after the payload: the `\n` ending its line, or the text's end. */
  end: number;
}

/**
 * Locate the payload of an event that is exactly one `data:` line.
 *
 * An event with two `data:` lines is one logical payload joined by newlines, and
 * putting that back together would mean re-serializing the event. An event
 * holding a `\r` was not framed on `\n` alone, and slicing a payload out of it
 * would leave the `\r` on the wrong side. Both are left to the caller as
 * byte-passthrough.
 */
function locateEventPayload(text: string): EventPayload | null {
  if (text.includes('\r')) return null;

  let found: EventPayload | null = null;
  let lineStart = 0;
  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? text.length : newline;
    if (text.startsWith('data:', lineStart)) {
      if (found) return null;
      // SSE allows the value to follow the colon with or without one space.
      const start = lineStart + 5 < lineEnd && text[lineStart + 5] === ' ' ? lineStart + 6 : lineStart + 5;
      found = { start, end: lineEnd };
    }
    lineStart = lineEnd + 1;
  }
  return found;
}

/**
 * Give back an extraction's leases, reporting rather than throwing.
 *
 * Only for the terminal path: the request's own outcome is the report, and the
 * store's `dispose` still deletes the file and counts any lease that was not
 * given back, so a failure here costs the count and not the cleanup.
 */
function releaseRefs(extraction: InlineExtraction, store: ResponseBlobStore): void {
  try {
    releaseExtractedBlobs(extraction, store);
  } catch (error) {
    console.warn(`[spool] SSE event ref release failed: ${(error as Error).message}`);
  }
}

/**
 * One event's bytes: everything before its payload, the payload read from the
 * scratch store in chunks, everything after it.
 *
 * `onDrained` runs once on every terminal path — the last byte handed over, the
 * client cancelling, a payload read failing — and only after this stream's read
 * handle is closed, so the store's files are deleted when nothing is reading them
 * (§5.5). It is also where the refs' leases and the event's spill are given back.
 */
function spliceEvent(init: {
  prefix: Uint8Array;
  suffix: Uint8Array;
  payload: ReadableStream<Uint8Array>;
  onDrained: () => Promise<void>;
}): ReadableStream<Uint8Array> {
  const reader = init.payload.getReader();
  /** 0: the text before the payload, 1: the payload, 2: the text after it. */
  let phase = 0;
  let drained = false;

  const drain = async (): Promise<void> => {
    if (drained) return;
    drained = true;
    try {
      // Closes the serializer's file handle, and is a no-op once the payload has
      // ended; a stream that already failed has closed its own.
      await reader.cancel();
    } catch { /* the caller is reporting the reason this ran */ }
    await init.onDrained();
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (phase === 0) {
          phase = 1;
          if (init.prefix.byteLength > 0) {
            controller.enqueue(init.prefix);
            return;
          }
        }

        if (phase === 1) {
          // One chunk per pull: the client's demand paces the scratch-store read
          // as well, so a stalled client holds no more than one chunk.
          for (;;) {
            let next: ReadableStreamReadResult<Uint8Array>;
            try {
              next = await reader.read();
            } catch (error) {
              // The payload cannot be read back out, so the event cannot be sent
              // whole. Error the stream rather than write a truncated event.
              await drain();
              controller.error(error);
              return;
            }
            if (next.done) break;
            if (next.value.byteLength > 0) {
              controller.enqueue(next.value);
              return;
            }
          }
          phase = 2;
        }

        if (init.suffix.byteLength > 0) {
          controller.enqueue(init.suffix);
        }
        await drain();
        controller.close();
      },
      async cancel() {
        await drain();
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * Frame an SSE stream one event at a time and spill any event above
 * `threshold_bytes`, returning the bytes to write to the client.
 *
 * The bytes are emitted in order and unmodified. An event past
 * `max_response_bytes` throws {@link SpoolResponseTooLargeError} out of the
 * returned stream and cancels the upstream body — the client connection is
 * aborted rather than a truncated body or a terminal `[DONE]` being sent (§5.7)
 * — and `SpoolCapacityError` is thrown when the live spill budget is exhausted,
 * also cancelling upstream. Both reach upstream through `receiveSpooledBody`,
 * which cancels the event stream it was handed on its way out, and every stop
 * path lands in {@link cancelSource} from there. Each event's spill is removed as
 * soon as its last byte has been handed over, or when the client cancels the
 * returned stream, which also cancels the upstream body.
 */
export function streamResponseEvents(
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const maxEventBytes = getSpoolConfig().maxResponseBytes;
  const reader = upstream.getReader();

  /** Bytes of the chunk that ended the previous event; they open the next one. */
  let rest: Uint8Array | null = null;
  /** Upstream reported the end of the stream. */
  let sourceEnded = false;
  /** The consumer went away: nothing may be enqueued or closed from here on. */
  let cancelled = false;
  /** The event currently being written to the client, once it is being read. */
  let event: ReadableStreamDefaultReader<Uint8Array> | null = null;
  /** Upstream has already been cancelled: cancelling a second time is not safe. */
  let sourceCancelled = false;

  /**
   * Cancel the upstream body exactly once.
   *
   * All three stop paths funnel here: an oversized event fails the returned
   * stream (and cancels upstream on the way out), a client cancel cancels the
   * framed event and then upstream, and the two can land together. Cancelling
   * twice is not reliably harmless — a `TransformStream` whose transformer has
   * called `controller.terminate()` (the converted handler bodies do that at
   * `[DONE]`) has had its cancel algorithm cleared by Node, so a later cancel of
   * its readable throws from inside Node and is reported only as an unhandled
   * rejection. One flag makes the paths agree, and a rejection raised by the
   * second cancel is swallowed by what is already an error path — the request
   * itself has already failed.
   */
  const cancelSource = async (reason?: unknown): Promise<void> => {
    if (sourceCancelled) return;
    sourceCancelled = true;
    try {
      await reader.cancel(reason);
    } catch { /* the caller is reporting the reason this ran */ }
  };

  /**
   * The next event as a byte stream, ending at the blank line that closes it or
   * at the end of the upstream stream. A pull reads upstream only while the
   * receiver is asking for event bytes, which is what keeps a slow client from
   * pulling the stream into this process.
   */
  const frameEvent = (): ReadableStream<Uint8Array> => {
    // Whether the last byte handed out was `\n`: the blank line that ends the
    // event may be split across two chunks, in which case its first `\n` has
    // already gone out and only the second one is left to find.
    let afterLf = false;
    /** The blank line was found; the next pull closes the stream. */
    let ended = false;

    return new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          for (;;) {
            if (ended || sourceEnded) {
              ended = true;
              controller.close();
              return;
            }

            // A leftover of the previous chunk is taken before upstream is read
            // again: an event boundary and the next event's first bytes can share
            // one chunk.
            let chunk: Uint8Array;
            if (rest) {
              chunk = rest;
              rest = null;
            } else {
              const { value, done } = await reader.read();
              if (done) {
                sourceEnded = true;
                continue;
              }
              chunk = value;
            }

            const completesBlankLine = afterLf && chunk.byteLength > 0 && chunk[0] === LF;
            const blankLine = completesBlankLine ? 0 : findBlankLine(chunk, 0);
            if (blankLine < 0) {
              if (chunk.byteLength > 0) {
                controller.enqueue(chunk);
                afterLf = chunk[chunk.byteLength - 1] === LF;
              }
              return;
            }

            // The blank line's first `\n` was handed over with the previous
            // chunk, so only this chunk's `\n` is left to write.
            const end = completesBlankLine ? 1 : blankLine + 2;
            controller.enqueue(chunk.subarray(0, end));
            rest = end < chunk.byteLength ? chunk.subarray(end) : null;
            ended = true;
            return;
          }
        },
        cancel(reason) {
          // The client is gone, or the event was refused: stop upstream rather
          // than leave it flowing into a body nobody will read.
          return cancelSource(reason);
        },
      },
      { highWaterMark: 0 },
    );
  };

  /**
   * Receive one framed event, or return null at the end of the stream.
   *
   * A zero-byte event is the end of the stream, not an event to forward: a tail
   * with no blank line only produces bytes when upstream actually sent some.
   */
  const receiveEvent = async (): Promise<SpoolBody | null> => {
    const body = await receiveSpooledBody(frameEvent(), {
      subdir: EVENT_SPILL_SUBDIR,
      filePrefix: EVENT_FILE_PREFIX,
      maxBytes: maxEventBytes,
      bodyLabel: 'SSE event',
      TooLargeError: SpoolResponseTooLargeError,
    });
    if (body.size === 0) {
      await body.release();
      return null;
    }
    return body;
  };

  /**
   * Turn one received event into the bytes to write to the client (§5.7).
   *
   * An event that did not spill is handed back as its own bytes, unread. An event
   * that did spill is the event this stage exists for: it is parsed, its
   * allowlisted payloads go to a scratch store of its own, and the event is
   * reassembled around the one payload it carries. Anything that is not a single
   * `data:` line holding JSON — a comment burst, a keep-alive, a `[DONE]`
   * sentinel — is replayed from its spill, so a large event this stage cannot
   * convert still goes out byte for byte.
   *
   * The returned stream owns the spill, the extraction's leases and the store. On
   * a throw the caller still owns the spill, and this has already deleted the
   * store it created.
   */
  const prepareEvent = async (body: SpoolBody): Promise<ReadableStream<Uint8Array>> => {
    if (!body.spilled) return body.readStream();

    // §5.9: parsing this event is exactly the materialization the budget is for,
    // and waiting here for it pauses the upstream reads rather than queuing them.
    const lease = await admitMaterialization(body.size);
    let store: ResponseBlobStore | null = null;
    try {
      const raw = await body.readBytes();
      let text: string;
      try {
        // Fatal, unlike `SpoolBody.readText`: the payload's span is cut out of
        // this text and put back on the wire, so a decode that replaced a byte
        // would change the event. An event that is not UTF-8 is replayed instead.
        // The BOM is kept for the same reason — with it, an event that opens with
        // one has a leading `﻿` rather than a `data:` line, so it is replayed
        // instead of having those bytes dropped.
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
      } catch {
        return body.readStream();
      }

      const payload = locateEventPayload(text);
      if (!payload) return body.readStream();

      let value: unknown;
      try {
        value = JSON.parse(text.slice(payload.start, payload.end));
      } catch {
        // Not JSON: §5.7 keeps non-JSON events byte-passthrough.
        return body.readStream();
      }

      const scratch = new ResponseBlobStore(EVENT_BLOB_SCOPE);
      store = scratch;
      const extraction = await extractResponseBlobs(value, scratch);
      if (extraction.refs === 0) {
        // Nothing allowlisted in this event: it goes out as it came in, and an
        // empty store has nothing to keep alive.
        await scratch.dispose();
        store = null;
        return body.readStream();
      }

      const prefix = Buffer.from(text.slice(0, payload.start), 'utf8');
      const suffix = Buffer.from(text.slice(payload.end), 'utf8');
      const { body: payloadBytes } = createRefAwareJsonBody(value, {
        readChunks: (hash, chunkBytes) => scratch.readChunks(hash, chunkBytes),
      });

      return spliceEvent({
        prefix,
        suffix,
        payload: payloadBytes,
        onDrained: async () => {
          // Ref first, then the spill, then the store: `dispose` awaits the
          // unlinks the final release scheduled, so the event leaves nothing
          // behind on any path (§5.7).
          releaseRefs(extraction, scratch);
          await body.release();
          const report = await scratch.dispose();
          if (report.leaked > 0) {
            console.warn(`[spool] SSE event ended with ${report.leaked} scratch lease(s) still held`);
          }
        },
      });
    } catch (error) {
      // Nothing of this event has been written yet. Its spill is the caller's
      // (they abort on it); the scratch store is ours and must not outlive us.
      await store?.dispose();
      throw error;
    } finally {
      // The payloads are on disk and only the skeleton is left in RAM.
      lease.release();
    }
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        for (;;) {
          if (cancelled) return;

          if (!event) {
            const body = await receiveEvent();
            // The client withdrew while the event was being received: its spill
            // is nobody's to read now, so hand back the reservation and the file.
            if (cancelled) {
              await body?.release();
              return;
            }
            if (!body) {
              controller.close();
              return;
            }
            let prepared: ReadableStream<Uint8Array>;
            try {
              prepared = await prepareEvent(body);
            } catch (error) {
              // An admission refusal or a scratch-store failure. The event has
              // not been sent at all, so the response fails here rather than
              // carrying on without it — and upstream is stopped on the way out.
              await body.release();
              await cancelSource(error);
              throw error;
            }
            if (cancelled) {
              // Prepared while the client was already going away: cancelling the
              // prepared stream gives back whatever it holds — spill, refs, store.
              await prepared.cancel();
              return;
            }
            // Ownership passes to the read stream, which releases what it holds
            // when the client has taken the last byte or the stream is cancelled.
            event = prepared.getReader();
            continue;
          }

          let result: ReadableStreamReadResult<Uint8Array>;
          try {
            result = await event.read();
          } catch (error) {
            // A spill that disappears or ends short must stop the producer as
            // well as erroring the client stream; otherwise later upstream
            // events continue into a response that has already failed.
            await cancelSource(error);
            throw error;
          }
          const { value, done } = result;
          if (done) {
            event = null;
            continue;
          }
          if (value && value.byteLength > 0) {
            controller.enqueue(value);
            return;
          }
        }
      },
      async cancel(reason) {
        cancelled = true;
        const open = event;
        event = null;
        // Stop both ends. Cancelling the read stream releases the event's spill,
        // so a client that disconnects mid-event frees the disk with it.
        await open?.cancel(reason);
        await cancelSource(reason);
      },
    },
    { highWaterMark: 0 },
  );
}
