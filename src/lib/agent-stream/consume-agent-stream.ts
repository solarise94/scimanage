/**
 * Shared browser Agent stream consumer (design §9.1 / plan §6.3).
 *
 * desktop (`agent-workbench.tsx`) and mobile (`agent-mobile-shell.tsx`) both
 * drive their `fetch("/api/agent/chat-stream")` POSTs through this single
 * consumer. It owns the only browser-side terminal-state machine so that:
 *
 *  - `response.completed` → onCompleted (the SOLE success terminal)
 *  - `response.failed`    → onFailed    (the SOLE failure terminal)
 *  - reader EOF with neither terminal seen → onDisconnectedBeforeTerminal
 *    (NEVER implicit success; caller triggers session reload to recalibrate)
 *
 * It also owns sequence de-duplication so a duplicated / backward / gapped
 * event never double-appends text or double-advances the invoice queue.
 *
 * Constraints:
 *  - no React/Next import (pure DOM fetch + ReadableStream reader)
 *  - user abort (AbortError) is distinguished from a transport failure and
 *    never reported as a failure terminal
 *  - unknown `scimanage.*` event types are ignored + logged, never fatal
 *  - malformed protocol frames become a typed failure (onFailed), never success
 *
 * Design refs:
 *  - docs/agent-openai-compatible-sse-migration-design-2026-07-28.md §9.1–§9.5, §12.1
 *  - docs/agent-openai-compatible-sse-execution-plan-2026-07-28.md §6.3
 */
import {
  AgentStreamProtocolError,
  type AgentStreamEvent,
} from "../../../agent-runtime/src/stream-protocol";
import { createSseEventDecoder } from "./decode-sse";

/**
 * Callbacks the consumer invokes. `onEvent` is called for every accepted
 * (de-duplicated, in-sequence) canonical event; exactly one terminal callback
 * fires per stream unless the user aborted (then only onAborted, if provided).
 */
export interface ConsumeAgentStreamCallbacks {
  /** Canonical event accepted (de-duplicated, sequence-forward). */
  onEvent(event: AgentStreamEvent): void;
  /** SOLE success terminal — saw `response.completed` then EOF. */
  onCompleted(event: Extract<AgentStreamEvent, { type: "response.completed" }>): void;
  /** SOLE failure terminal — saw `response.failed` (or malformed protocol). */
  onFailed(event: Extract<AgentStreamEvent, { type: "response.failed" }>): void;
  /**
   * Reader EOF without seeing completed/failed. Caller must NOT mark the turn
   * done; trigger a session reload to recalibrate against the server snapshot.
   */
  onDisconnectedBeforeTerminal(): void;
  /**
   * Optional: user abort fired before any terminal event was observed. Defaults
   * to a no-op so callers that handle AbortError at the fetch site are fine.
   */
  onAborted?(): void;
  /**
   * Optional: a transport-level error other than abort (e.g. malformed protocol
   * surfaced as onFailed carries the failed event; this is for non-terminal
   * diagnostics like sequence gaps / backward warnings). Defaults to console.warn.
   */
  onWarning?(message: string, context?: Record<string, unknown>): void;
}

export interface ConsumeAgentStreamOptions extends ConsumeAgentStreamCallbacks {
  /** AbortSignal bound to the fetch (and the user's stop button / unmount). */
  signal?: AbortSignal;
}

/** Internal terminal-state tracker for one response stream. */
type Terminal = "none" | "completed" | "failed";

/**
 * Consume a canonical SSE Agent stream from a fetch Response body.
 *
 * Returns when the reader reaches EOF OR a terminal event + EOF has been seen,
 * OR an AbortError was thrown by the reader. The caller's per-turn logic runs
 * after this resolves and reads the returned {@link ConsumeResult} to decide
 * queue advancement / session reload.
 */
export type ConsumeResult =
  | { terminal: "completed" }
  | { terminal: "failed" }
  | { terminal: "disconnected" }
  | { terminal: "aborted" };

export async function consumeAgentStream(
  response: Response,
  options: ConsumeAgentStreamOptions,
): Promise<ConsumeResult> {
  const {
    signal,
    onEvent,
    onCompleted,
    onFailed,
    onDisconnectedBeforeTerminal,
    onAborted,
    onWarning,
  } = options;

  const warn = onWarning ?? ((msg: string, ctx?: Record<string, unknown>) => {
    console.warn(`[consume-agent-stream] ${msg}`, ctx ?? "");
  });

  const body = response.body;
  if (!body) {
    // No body at all — there is nothing to read and no terminal can be seen.
    onDisconnectedBeforeTerminal();
    return { terminal: "disconnected" };
  }

  const decoder = createSseEventDecoder();
  const reader = body.getReader();

  // De-dup state. `seenEventIds` catches a literal duplicate frame (same id:).
  // `lastSequence` enforces monotonic +1 per response_id; duplicates/backward
  // are dropped with a warning, gaps are logged but tolerated (no auto-reconnect
  // in this phase — design §9.4).
  let terminal: Terminal = "none";
  let lastSequence: number | undefined;
  let terminalEvent:
    | Extract<AgentStreamEvent, { type: "response.completed" }>
    | Extract<AgentStreamEvent, { type: "response.failed" }>
    | undefined;
  const seenEventIds = new Set<string>();

  function eventId(ev: AgentStreamEvent): string {
    return `${ev.response_id}:${ev.sequence_number}`;
  }

  function observeSequence(ev: AgentStreamEvent): boolean {
    // Read sequence as a plain number to avoid literal-type narrowing on
    // response.created (whose sequence_number is typed as the literal 0).
    const seq = ev.sequence_number as number;
    // response.created must be sequence 0 and is the anchor.
    const isCreated = ev.type === "response.created";
    if (isCreated && seq !== 0) {
      warn("response.created sequence_number != 0; ignoring", { sequence_number: seq });
      return false;
    }
    if (lastSequence === undefined) {
      if (!isCreated && seq !== 0) {
        warn("first event was not response.created; accepting as anchor", {
          type: ev.type,
          sequence_number: seq,
        });
      }
      lastSequence = seq;
      return true;
    }
    if (seq === lastSequence) {
      warn("duplicate sequence_number dropped", { sequence_number: seq, type: ev.type });
      return false;
    }
    if (seq < lastSequence) {
      warn("backward sequence_number dropped", { last: lastSequence, actual: seq, type: ev.type });
      return false;
    }
    const expected = lastSequence + 1;
    if (seq > expected) {
      // Gap — log telemetry; do NOT reconnect (design §9.4).
      warn("sequence gap detected", { expected, actual: seq });
    }
    lastSequence = seq;
    return true;
  }

  function accept(ev: AgentStreamEvent): void {
    const id = eventId(ev);
    if (seenEventIds.has(id)) {
      warn("duplicate event id dropped", { id });
      return;
    }
    seenEventIds.add(id);
    if (!observeSequence(ev)) return;
    onEvent(ev);
    if (ev.type === "response.completed" || ev.type === "response.failed") {
      // Assign terminal via a widened local so the comparison against the
      // discriminated literal union does not narrow `terminal` to `never`.
      const nextTerminal: Terminal = ev.type === "response.completed" ? "completed" : "failed";
      terminal = nextTerminal;
      terminalEvent = ev;
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      let events: AgentStreamEvent[];
      try {
        events = decoder.push(value).events;
      } catch (err) {
        // Malformed wire frame → typed protocol failure. Treat as a transport
        // failure terminal (design §9.1: malformed → typed error, never success).
        const message =
          err instanceof AgentStreamProtocolError
            ? err.message
            : err instanceof Error
              ? err.message
              : "malformed agent stream";
        const failed = buildFailedFromError(message);
        onEvent(failed);
        onFailed(failed);
        return { terminal: "failed" };
      }
      for (const ev of events) accept(ev);
    }
    // EOF. Assert no residual partial frame (a stray partial frame is a
    // transport failure, not implicit success).
    try {
      decoder.flush();
    } catch (err) {
      const message =
        err instanceof AgentStreamProtocolError
          ? err.message
          : err instanceof Error
            ? err.message
            : "residual frame at EOF";
      const failed = buildFailedFromError(message);
      onEvent(failed);
      onFailed(failed);
      return { terminal: "failed" };
    }
    // `terminal` is mutated inside the `accept` closure; cast to Terminal so TS's
    // control-flow (which sees only the `"none"` initializer) does not narrow it.
    const finalTerminal = terminal as Terminal;
    if (finalTerminal === "completed" && terminalEvent && terminalEvent.type === "response.completed") {
      onCompleted(terminalEvent);
      return { terminal: "completed" };
    }
    if (finalTerminal === "failed" && terminalEvent && terminalEvent.type === "response.failed") {
      onFailed(terminalEvent);
      return { terminal: "failed" };
    }
    // EOF without a terminal event — do NOT mark done. Hand back to caller so
    // it can trigger session reload recalibration (design §9.1 / §12.3).
    onDisconnectedBeforeTerminal();
    return { terminal: "disconnected" };
  } catch (err) {
    // Distinguish user abort from a transport failure. An AbortError is raised
    // when the caller's AbortController fires (stop button / unmount / switch).
    if (isAbortError(err) || (signal && signal.aborted)) {
      onAborted?.();
      return { terminal: "aborted" };
    }
    // Genuine transport failure (network drop mid-stream). Report as failed
    // terminal with a synthetic response.failed so the UI flips to error and
    // the caller does not treat EOF-like drop as success.
    const message = err instanceof Error ? err.message : "agent stream transport failed";
    const failed = buildFailedFromError(message);
    onEvent(failed);
    onFailed(failed);
    return { terminal: "failed" };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released / locked elsewhere — ignore
    }
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof DOMException && err.name === "AbortError"
  ) || (err instanceof Error && err.name === "AbortError");
}

function buildFailedFromError(message: string): Extract<AgentStreamEvent, { type: "response.failed" }> {
  // Synthetic transport-level failure event. sequence_number/created_at are
  // informational here (the canonical validator on the producer side owns the
  // real numbering); the consumer's failure callback only reads `error.message`.
  return {
    type: "response.failed",
    protocol: "scimanage-agent-sse-v1",
    response_id: `transport_${Date.now()}`,
    sequence_number: Number.MAX_SAFE_INTEGER,
    error: { message },
  } as Extract<AgentStreamEvent, { type: "response.failed" }>;
}

/**
 * Per-turn canonical-event predicate: did this turn's `finance.analyze_invoice_file`
 * tool execution fail? Used by desktop/mobile per-turn queue-advance logic so a
 * failed analyze drives exactly-one queue advance once busy is released, without
 * scanning historical "failed" items (which would re-trigger on every later turn).
 */
export function isInvoiceAnalyzeFailureEvent(ev: AgentStreamEvent): boolean {
  return (
    ev.type === "scimanage.tool_execution.failed" &&
    ev.tool_name === "finance.analyze_invoice_file"
  );
}

export type { AgentStreamEvent };
