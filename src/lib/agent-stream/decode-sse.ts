/**
 * Streaming SSE decoder for the canonical Agent stream protocol.
 *
 * Browser/server-agnostic. Decodes raw `Uint8Array` chunks (e.g. from a fetch
 * `ReadableStream` reader) into validated {@link AgentStreamEvent} objects.
 *
 * Design refs:
 *  - docs/agent-openai-compatible-sse-migration-design-2026-07-28.md §4.4 / §9.1
 *  - docs/agent-openai-compatible-sse-execution-plan-2026-07-28.md §3.3 / §3.4
 *
 * Constraints:
 *  - no React/Next import
 *  - does NOT assume chunk == frame boundary (frames may span chunks)
 *  - does NOT assume UTF-8 codepoints align with chunk boundaries
 *  - output is plain event objects; never mutates UI state
 *  - malformed wire → typed {@link AgentStreamProtocolError} (no silent swallow)
 *
 * The canonical event contract + error type are re-exported from the shared
 * protocol module so there is exactly one event union in the repo.
 */

import type {
  AgentStreamEvent,
  AgentStreamEventType,
} from "../../../agent-runtime/src/stream-protocol";
import {
  AgentStreamProtocolError,
  parseAgentStreamEvent,
} from "../../../agent-runtime/src/stream-protocol";

export type {
  AgentStreamEvent,
  AgentStreamEventType,
} from "../../../agent-runtime/src/stream-protocol";
// AgentStreamProtocolError is a class (value), re-export as value.
export {
  AgentStreamProtocolError,
} from "../../../agent-runtime/src/stream-protocol";

/** Result of pushing bytes into the decoder. */
export interface SseDecodeResult {
  /** Fully parsed events from this push (possibly empty). */
  events: AgentStreamEvent[];
  /**
   * Bytes still buffered (waiting for the frame terminator). Always 0 once
   * {@link SseEventDecoder.flush} is called with no pending partial frame.
   */
  pendingBytes: number;
}

/**
 * Stateful, environment-agnostic SSE decoder.
 *
 * Lifecycle:
 *   const decoder = createSseEventDecoder();
 *   for await (const chunk of reader) {
 *     const { events } = decoder.push(chunk);  // Uint8Array
 *     for (const ev of events) handle(ev);
 *   }
 *   decoder.flush();  // assert no residual partial frame
 *
 * EOF residual-frame policy (plan §3.3.3): a partial frame left in the buffer
 * at EOF is treated as a protocol error (RESIDUAL_FRAME_AT_EOF). Callers that
 * intentionally end on a non-terminal boundary (e.g. server is known to always
 * terminate frames) can ignore the thrown error.
 */
export interface SseEventDecoder {
  /** Feed bytes; returns events completed by this chunk. */
  push(chunk: Uint8Array): SseDecodeResult;
  /**
   * Signal end-of-stream. If a partial frame remains, throws
   * {@link AgentStreamProtocolError} with code `RESIDUAL_FRAME_AT_EOF`.
   */
  flush(): void;
}

const EMPTY: SseDecodeResult = { events: [], pendingBytes: 0 };

/**
 * Match the frame terminator. We detect the FIRST occurrence of either
 * `\n\n` (0x0A 0x0A) or `\r\n\r\n` (0x0D 0x0A 0x0D 0x0A) in the buffer.
 * Returns the index right after the terminator (start of next frame), or -1.
 *
 * Per SSE spec, a blank line separates events. We accept both LF and CRLF
 * line endings and the common producer variants.
 */
function findFrameEnd(buf: Uint8Array): { end: number; terminatorLen: number } | null {
  // Look for \n\n first (covers LF-only and the tail of CRLF\n).
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0x0a && buf[i + 1] === 0x0a) {
      return { end: i + 2, terminatorLen: 2 };
    }
    if (
      i + 3 < buf.length &&
      buf[i] === 0x0d &&
      buf[i + 1] === 0x0a &&
      buf[i + 2] === 0x0d &&
      buf[i + 3] === 0x0a
    ) {
      return { end: i + 4, terminatorLen: 4 };
    }
  }
  return null;
}

export function createSseEventDecoder(): SseEventDecoder {
  // TextDecoder is a Web standard global available in Node 18+ and browsers.
  // We construct it once and reuse; `stream: true` is the default for the
  // constructor-less form. We pass { stream: true } on decode calls so a
  // multi-byte UTF-8 sequence split across chunks is buffered internally and
  // NOT emitted as a replacement char.
  const decoder = new TextDecoder("utf-8");
  // Pending bytes that have not yet formed a complete frame.
  let pending: Uint8Array = new Uint8Array(0);

  function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  function parseFrame(frameText: string): AgentStreamEvent {
    // Normalize CRLF → LF for line splitting (handles producers using \r\n).
    const normalized = frameText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    // Drop a trailing newline that was part of the terminator boundary (the
    // terminator is excluded from frameText, but be defensive).
    const lines = normalized.split("\n");

    let eventType: string | undefined;
    let eventId: string | undefined;
    const dataLines: string[] = [];

    for (const rawLine of lines) {
      if (rawLine === "") continue; // blank intra-frame line ignored
      if (rawLine.startsWith(":")) continue; // SSE comment / heartbeat
      const colon = rawLine.indexOf(":");
      const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
      // Per spec, a single leading space after the colon is stripped.
      let value = colon === -1 ? "" : rawLine.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      switch (field) {
        case "event":
          eventType = value;
          break;
        case "id":
          eventId = value;
          break;
        case "data":
          dataLines.push(value);
          break;
        default:
          // Unknown field (retry, etc.) — ignored. We do not surface them in
          // the canonical contract; silently dropping is SSE-conformant.
          break;
      }
    }

    if (dataLines.length === 0) {
      throw new AgentStreamProtocolError(
        "MALFORMED_EVENT_JSON",
        "SSE frame has no data line",
        { frame: frameText },
      );
    }

    const dataStr = dataLines.join("\n");
    let json: unknown;
    try {
      json = JSON.parse(dataStr);
    } catch (err) {
      throw new AgentStreamProtocolError(
        "MALFORMED_EVENT_JSON",
        `SSE data is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        { frame: frameText },
      );
    }

    const event = parseAgentStreamEvent(json);

    // Cross-check: event: line must equal data.type (plan §3.3.3).
    if (eventType !== undefined && eventType !== event.type) {
      throw new AgentStreamProtocolError(
        "EVENT_TYPE_MISMATCH",
        `SSE event: line "${eventType}" does not match data.type "${event.type}"`,
        { frame: frameText },
      );
    }

    // Optional id consistency check: id should equal `${response_id}:${sequence_number}`.
    // We only validate when an id: line was present; producers omitting it are fine.
    if (eventId !== undefined) {
      const expected = `${event.response_id}:${event.sequence_number}`;
      if (eventId !== expected) {
        throw new AgentStreamProtocolError(
          "EVENT_TYPE_MISMATCH",
          `SSE id "${eventId}" does not match response_id:sequence_number "${expected}"`,
          { frame: frameText },
        );
      }
    }

    return event;
  }

  function push(chunk: Uint8Array): SseDecodeResult {
    if (chunk.length === 0) {
      return { events: [], pendingBytes: pending.length };
    }
    let buf = concat(pending, chunk);
    const events: AgentStreamEvent[] = [];

    while (true) {
      const found = findFrameEnd(buf);
      if (!found) break;
      const frameBytes = buf.subarray(0, found.end - found.terminatorLen);
      // Decode just this frame; remaining bytes stay encoded to avoid splitting
      // multi-byte sequences that span the frame boundary.
      const frameText = decoder.decode(frameBytes, { stream: true });
      events.push(parseFrame(frameText));
      buf = buf.subarray(found.end);
    }

    pending = buf;
    return { events, pendingBytes: pending.length };
  }

  function flush(): void {
    if (pending.length === 0) {
      // Flush the decoder's internal UTF-8 tail (should be empty for well-formed input).
      const tail = decoder.decode();
      if (tail.length > 0) {
        throw new AgentStreamProtocolError(
          "RESIDUAL_FRAME_AT_EOF",
          `residual undecoded bytes at EOF: ${tail.length} chars`,
          { frame: tail },
        );
      }
      return;
    }
    const frameText = decoder.decode(); // finalize
    throw new AgentStreamProtocolError(
      "RESIDUAL_FRAME_AT_EOF",
      `partial SSE frame left at EOF (${pending.length} bytes)`,
      { frame: frameText },
    );
  }

  return { push, flush };
}

export { EMPTY };
