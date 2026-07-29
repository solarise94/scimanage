/**
 * Canonical Agent SSE wire protocol — `scimanage-agent-sse-v1`.
 *
 * Single source of truth for the Agent stream event contract shared by:
 *  - `agent-runtime` (emitter)
 *  - Next.js server (runtime decoder + native route encoder)
 *  - browser consumer (desktop/mobile, type-only)
 *
 * Design refs:
 *  - docs/agent-openai-compatible-sse-migration-design-2026-07-28.md §4 / §5
 *  - docs/agent-openai-compatible-sse-execution-plan-2026-07-28.md §3
 *
 * Pure-module constraints (design §4.2 / plan §3.4):
 *  - no Node HTTP, no Pi SDK, no Next, no React, no Prisma
 *  - no env reads
 *  - no business permission / query logic
 *
 * This module MUST stay environment-agnostic. Do not import Node-only APIs.
 */

/** Wire protocol version constant. Every event MUST carry this exact string. */
export const AGENT_STREAM_PROTOCOL = "scimanage-agent-sse-v1" as const;
export type AgentStreamProtocol = typeof AGENT_STREAM_PROTOCOL;

/**
 * Agent token usage snapshot. All fields optional; emitters fill what they know.
 * Design §5.6.
 */
export interface AgentUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

/** Structured error payload shared by response.failed / tool failed / error events. */
export interface AgentStreamError {
  /** Machine-readable error code (e.g. `NEEDS_USER_CONFIRMATION`, `STREAM_TRANSPORT_MISMATCH`). */
  code?: string;
  /** Human-readable message (Chinese or English per emitter). */
  message: string;
  /** Hint whether the caller may retry the turn. */
  retryable?: boolean;
}

/** Common base fields required on every canonical event. Design §4.3. */
export interface AgentStreamEventBase {
  /** Discriminant; MUST equal the SSE `event:` line. */
  type: AgentStreamEventType;
  /** Fixed protocol marker. */
  protocol: AgentStreamProtocol;
  /** Per-turn id; runtime and Next.js keep it stable across the whole turn. */
  response_id: string;
  /** Strictly monotonic per response_id; response.created is always 0. */
  sequence_number: number;
}

/** Optional identity / timing fields present on most events. */
export interface AgentStreamEventMeta extends AgentStreamEventBase {
  session_id?: string;
  agent_run_id?: string;
  /** Unix epoch milliseconds (emitter clock). */
  created_at?: number;
}

// ── Discriminated event union ──────────────────────────────────────────────
//
// The union is closed (no `[key: string]: unknown`). New event types must be
// added here AND to AGENT_STREAM_EVENT_TYPES / the type guard. Design §4.2
// explicitly forbids a second hand-written event union.

export interface ResponseCreatedEvent extends AgentStreamEventMeta {
  type: "response.created";
  /** Always 0 for a given response_id (validated by emitter / consumer). */
  sequence_number: 0;
  session_id: string;
  agent_run_id: string;
}

export interface ResponseInProgressEvent extends AgentStreamEventMeta {
  type: "response.in_progress";
}

export interface ResponseOutputTextDeltaEvent extends AgentStreamEventMeta {
  type: "response.output_text.delta";
  /** Incremental assistant text. Client concatenates in order. */
  delta: string;
}

export interface ResponseOutputTextDoneEvent extends AgentStreamEventMeta {
  type: "response.output_text.done";
  /** Full calibrated assistant text for the turn (for final reconciliation). */
  text: string;
}

export interface ResponseCompletedEvent extends AgentStreamEventMeta {
  type: "response.completed";
  status: "completed";
  usage?: AgentUsage;
}

export interface ResponseFailedEvent extends AgentStreamEventMeta {
  type: "response.failed";
  error: AgentStreamError;
}

/** Generic protocol-level error; may precede response.failed. */
export interface ErrorEvent extends AgentStreamEventMeta {
  type: "error";
  error: AgentStreamError;
}

export interface ScimanageActivityStartedEvent extends AgentStreamEventMeta {
  type: "scimanage.activity.started";
  activity_id: string;
  label: string;
}

export interface ScimanageActivityCompletedEvent extends AgentStreamEventMeta {
  type: "scimanage.activity.completed";
  activity_id: string;
}

export interface ScimanageToolExecutionStartedEvent extends AgentStreamEventMeta {
  type: "scimanage.tool_execution.started";
  tool_execution_id: string;
  tool_name: string;
  label: string;
  input?: unknown;
}

export interface ScimanageToolExecutionCompletedEvent extends AgentStreamEventMeta {
  type: "scimanage.tool_execution.completed";
  tool_execution_id: string;
  tool_name: string;
  label: string;
  output?: unknown;
}

export interface ScimanageToolExecutionFailedEvent extends AgentStreamEventMeta {
  type: "scimanage.tool_execution.failed";
  tool_execution_id: string;
  tool_name: string;
  label: string;
  error: AgentStreamError;
  /**
   * For NEEDS_USER_CONFIRMATION failures: the confirm action key the UI must
   * mint a matching AgentUserConfirmationEvent for. Design §5.3 / §5.8.
   */
  target_intent?: string;
}

export interface ScimanageContextCompactionStartedEvent extends AgentStreamEventMeta {
  type: "scimanage.context_compaction.started";
}

export interface ScimanageContextCompactionCompletedEvent extends AgentStreamEventMeta {
  type: "scimanage.context_compaction.completed";
  tokens_before?: number;
  tokens_after?: number;
}

export interface ScimanageContextCompactionWarningEvent extends AgentStreamEventMeta {
  type: "scimanage.context_compaction.warning";
  message?: string;
}

/**
 * Memory suggestion. `memory` mirrors the legacy `memory_suggestion.memory`
 * payload emitted by pi-runtime's `agent.save_memory` tool result `details`
 * (the persisted memory record). Design §5.5.
 */
export interface ScimanageMemorySuggestedEvent extends AgentStreamEventMeta {
  type: "scimanage.memory.suggested";
  memory: Record<string, unknown>;
}

/**
 * View intent. `intent` mirrors the legacy `view_intent.intent` payload
 * (agent.suggest_view tool args: type/route/entityType/entityId/panel/label/...).
 * Design §5.5.
 */
export interface ScimanageViewIntentCreatedEvent extends AgentStreamEventMeta {
  type: "scimanage.view_intent.created";
  intent: Record<string, unknown>;
}

/**
 * Proactive task suggestion. `task` mirrors the legacy
 * `proactive_task_suggestion.task` payload (persisted AgentProactiveTask record).
 * Design §5.5.
 */
export interface ScimanageProactiveTaskSuggestedEvent extends AgentStreamEventMeta {
  type: "scimanage.proactive_task.suggested";
  task: Record<string, unknown>;
}

export interface ScimanageUsageUpdatedEvent extends AgentStreamEventMeta {
  type: "scimanage.usage.updated";
  usage: AgentUsage;
}

/** Canonical discriminated union — the only event contract in the repo. */
export type AgentStreamEvent =
  | ResponseCreatedEvent
  | ResponseInProgressEvent
  | ResponseOutputTextDeltaEvent
  | ResponseOutputTextDoneEvent
  | ResponseCompletedEvent
  | ResponseFailedEvent
  | ErrorEvent
  | ScimanageActivityStartedEvent
  | ScimanageActivityCompletedEvent
  | ScimanageToolExecutionStartedEvent
  | ScimanageToolExecutionCompletedEvent
  | ScimanageToolExecutionFailedEvent
  | ScimanageContextCompactionStartedEvent
  | ScimanageContextCompactionCompletedEvent
  | ScimanageContextCompactionWarningEvent
  | ScimanageMemorySuggestedEvent
  | ScimanageViewIntentCreatedEvent
  | ScimanageProactiveTaskSuggestedEvent
  | ScimanageUsageUpdatedEvent;

/** Ordered list of all canonical event type strings. */
export const AGENT_STREAM_EVENT_TYPES = [
  "response.created",
  "response.in_progress",
  "response.output_text.delta",
  "response.output_text.done",
  "response.completed",
  "response.failed",
  "error",
  "scimanage.activity.started",
  "scimanage.activity.completed",
  "scimanage.tool_execution.started",
  "scimanage.tool_execution.completed",
  "scimanage.tool_execution.failed",
  "scimanage.context_compaction.started",
  "scimanage.context_compaction.completed",
  "scimanage.context_compaction.warning",
  "scimanage.memory.suggested",
  "scimanage.view_intent.created",
  "scimanage.proactive_task.suggested",
  "scimanage.usage.updated",
] as const;

export type AgentStreamEventType = (typeof AGENT_STREAM_EVENT_TYPES)[number];

// ── Typed protocol error ────────────────────────────────────────────────────

export type AgentStreamProtocolErrorCode =
  | "PROTOCOL_VERSION_MISMATCH"
  | "UNKNOWN_EVENT_TYPE"
  | "EVENT_TYPE_MISMATCH"
  | "MALFORMED_EVENT_JSON"
  | "MISSING_REQUIRED_FIELD"
  | "INVALID_FIELD_TYPE"
  | "RESIDUAL_FRAME_AT_EOF";

/**
 * Typed error thrown by validators / decoder. Carries frame context so callers
 * can log without swallowing. Design §3.4: malformed wire returns typed error.
 */
export class AgentStreamProtocolError extends Error {
  readonly code: AgentStreamProtocolErrorCode;
  readonly frame?: string;
  constructor(
    code: AgentStreamProtocolErrorCode,
    message: string,
    options?: { frame?: string; cause?: unknown },
  ) {
    // Prefix the message with the code so log lines, test matchers and
    // consumers parsing `.message` all see the typed code without needing
    // to introspect `.code`.
    super(`[${code}] ${message}`, options?.cause != null ? { cause: options.cause } : undefined);
    this.name = "AgentStreamProtocolError";
    this.code = code;
    if (options?.frame !== undefined) this.frame = options.frame;
  }
}

// ── Type guards / validators ────────────────────────────────────────────────

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(AGENT_STREAM_EVENT_TYPES);

/** True if `value` is one of the canonical event type strings. */
export function isAgentStreamEventType(value: unknown): value is AgentStreamEventType {
  return typeof value === "string" && EVENT_TYPE_SET.has(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringField(value: unknown): value is string {
  return typeof value === "string";
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isOptionalUnknown(value: unknown): value is unknown | undefined {
  return true; // optional arbitrary value; presence only checked by callers
}

function isAgentStreamError(value: unknown): value is AgentStreamError {
  if (!isObject(value)) return false;
  if (!isStringField(value.message) || value.message.length === 0) return false;
  if (!isOptionalString(value.code)) return false;
  if (value.retryable !== undefined && typeof value.retryable !== "boolean") return false;
  return true;
}

function isAgentUsage(value: unknown): value is AgentUsage {
  if (!isObject(value)) return false;
  const numKeys: Array<keyof AgentUsage> = [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
  ];
  for (const key of numKeys) {
    const v = value[key];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) return false;
  }
  return true;
}

/**
 * Minimal structural validator. Does NOT attempt to validate `input`/`output`/
 * `memory`/`intent`/`task` payloads (they are intentionally `unknown`/records),
 * only the protocol-required envelope and the per-type required fields.
 *
 * Throws {@link AgentStreamProtocolError} with a typed code on any violation.
 * Returns the same object narrowed to {@link AgentStreamEvent}.
 */
export function parseAgentStreamEvent(json: unknown): AgentStreamEvent {
  if (!isObject(json)) {
    throw new AgentStreamProtocolError("MALFORMED_EVENT_JSON", "event is not an object");
  }

  const type = json.type;
  if (!isAgentStreamEventType(type)) {
    throw new AgentStreamProtocolError(
      "UNKNOWN_EVENT_TYPE",
      `unknown event type: ${String(type)}`,
    );
  }

  if (json.protocol !== AGENT_STREAM_PROTOCOL) {
    throw new AgentStreamProtocolError(
      "PROTOCOL_VERSION_MISMATCH",
      `expected protocol "${AGENT_STREAM_PROTOCOL}", got ${JSON.stringify(json.protocol)}`,
    );
  }

  if (!isStringField(json.response_id) || json.response_id.length === 0) {
    throw new AgentStreamProtocolError(
      "MISSING_REQUIRED_FIELD",
      `event ${type}: response_id must be a non-empty string`,
    );
  }
  if (typeof json.sequence_number !== "number" || !Number.isFinite(json.sequence_number) || json.sequence_number < 0) {
    throw new AgentStreamProtocolError(
      "INVALID_FIELD_TYPE",
      `event ${type}: sequence_number must be a finite non-negative number`,
    );
  }

  // per-type required-field checks
  switch (type) {
    case "response.created":
      if (json.sequence_number !== 0) {
        throw new AgentStreamProtocolError(
          "INVALID_FIELD_TYPE",
          "response.created must have sequence_number 0",
        );
      }
      if (!isStringField(json.session_id) || json.session_id.length === 0) {
        throw new AgentStreamProtocolError(
          "MISSING_REQUIRED_FIELD",
          "response.created requires session_id",
        );
      }
      if (!isStringField(json.agent_run_id) || json.agent_run_id.length === 0) {
        throw new AgentStreamProtocolError(
          "MISSING_REQUIRED_FIELD",
          "response.created requires agent_run_id",
        );
      }
      break;
    case "response.output_text.delta":
      if (!isStringField(json.delta)) {
        throw new AgentStreamProtocolError(
          "MISSING_REQUIRED_FIELD",
          "response.output_text.delta requires string delta",
        );
      }
      break;
    case "response.output_text.done":
      if (!isStringField(json.text)) {
        throw new AgentStreamProtocolError(
          "MISSING_REQUIRED_FIELD",
          "response.output_text.done requires string text",
        );
      }
      break;
    case "response.completed":
      if (json.status !== "completed") {
        throw new AgentStreamProtocolError(
          "INVALID_FIELD_TYPE",
          "response.completed status must be \"completed\"",
        );
      }
      if (json.usage !== undefined && !isAgentUsage(json.usage)) {
        throw new AgentStreamProtocolError("INVALID_FIELD_TYPE", "response.completed usage malformed");
      }
      break;
    case "response.failed":
    case "error":
      if (!isAgentStreamError(json.error)) {
        throw new AgentStreamProtocolError(
          "INVALID_FIELD_TYPE",
          `${type} requires error { message: string, code?: string, retryable?: boolean }`,
        );
      }
      break;
    case "scimanage.activity.started":
      if (!isStringField(json.activity_id) || !isStringField(json.label)) {
        throw new AgentStreamProtocolError(
          "MISSING_REQUIRED_FIELD",
          "scimanage.activity.started requires activity_id + label",
        );
      }
      break;
    case "scimanage.activity.completed":
      if (!isStringField(json.activity_id)) {
        throw new AgentStreamProtocolError(
          "MISSING_REQUIRED_FIELD",
          "scimanage.activity.completed requires activity_id",
        );
      }
      break;
    case "scimanage.tool_execution.started":
    case "scimanage.tool_execution.completed":
    case "scimanage.tool_execution.failed": {
      const needId = !isStringField(json.tool_execution_id);
      const needName = !isStringField(json.tool_name);
      const needLabel = !isStringField(json.label);
      if (needId || needName || needLabel) {
        throw new AgentStreamProtocolError(
          "MISSING_REQUIRED_FIELD",
          `${type} requires tool_execution_id + tool_name + label`,
        );
      }
      if (type === "scimanage.tool_execution.started") {
        isOptionalUnknown(json.input); // no-op; input is unknown?
      } else if (type === "scimanage.tool_execution.completed") {
        isOptionalUnknown(json.output);
      } else {
        if (!isAgentStreamError(json.error)) {
          throw new AgentStreamProtocolError(
            "INVALID_FIELD_TYPE",
            "scimanage.tool_execution.failed requires error { message, code?, retryable? }",
          );
        }
        if (!isOptionalString(json.target_intent)) {
          throw new AgentStreamProtocolError(
            "INVALID_FIELD_TYPE",
            "scimanage.tool_execution.failed target_intent must be a string",
          );
        }
      }
      break;
    }
    case "scimanage.context_compaction.started":
      break;
    case "scimanage.context_compaction.completed":
      if (!isOptionalNumber(json.tokens_before) || !isOptionalNumber(json.tokens_after)) {
        throw new AgentStreamProtocolError(
          "INVALID_FIELD_TYPE",
          "scimanage.context_compaction.completed tokens_before/after must be numbers",
        );
      }
      break;
    case "scimanage.context_compaction.warning":
      if (!isOptionalString(json.message)) {
        throw new AgentStreamProtocolError(
          "INVALID_FIELD_TYPE",
          "scimanage.context_compaction.warning message must be a string",
        );
      }
      break;
    case "scimanage.memory.suggested":
      if (!isObject(json.memory)) {
        throw new AgentStreamProtocolError(
          "MISSING_REQUIRED_FIELD",
          "scimanage.memory.suggested requires memory object",
        );
      }
      break;
    case "scimanage.view_intent.created":
      if (!isObject(json.intent)) {
        throw new AgentStreamProtocolError(
          "MISSING_REQUIRED_FIELD",
          "scimanage.view_intent.created requires intent object",
        );
      }
      break;
    case "scimanage.proactive_task.suggested":
      if (!isObject(json.task)) {
        throw new AgentStreamProtocolError(
          "MISSING_REQUIRED_FIELD",
          "scimanage.proactive_task.suggested requires task object",
        );
      }
      break;
    case "scimanage.usage.updated":
      if (!isAgentUsage(json.usage)) {
        throw new AgentStreamProtocolError("INVALID_FIELD_TYPE", "scimanage.usage.updated usage malformed");
      }
      break;
    case "response.in_progress":
      break;
    default: {
      // exhaustiveness guard
      const _exhaustive: never = type;
      void _exhaustive;
    }
  }

  // optional meta fields type-check (do not throw on absence — they are optional)
  if (!isOptionalString(json.session_id)) {
    throw new AgentStreamProtocolError("INVALID_FIELD_TYPE", "session_id must be a string");
  }
  if (!isOptionalString(json.agent_run_id)) {
    throw new AgentStreamProtocolError("INVALID_FIELD_TYPE", "agent_run_id must be a string");
  }
  if (!isOptionalNumber(json.created_at)) {
    throw new AgentStreamProtocolError("INVALID_FIELD_TYPE", "created_at must be a number");
  }

  return json as unknown as AgentStreamEvent;
}

/** Type guard returning the parsed event or null (no throw). */
export function tryParseAgentStreamEvent(json: unknown): AgentStreamEvent | null {
  try {
    return parseAgentStreamEvent(json);
  } catch {
    return null;
  }
}

// ── SSE encoder ─────────────────────────────────────────────────────────────

/**
 * Deterministic SSE event id: `${response_id}:${sequence_number}`.
 * Design §4.3 / §4.4.
 */
export function agentStreamEventId(event: Pick<AgentStreamEventBase, "response_id" | "sequence_number">): string {
  return `${event.response_id}:${event.sequence_number}`;
}

/**
 * Encode one canonical event to an SSE frame string.
 *
 * Frame shape (design §4.4):
 * ```
 * event: <type>\n
 * id: <response_id>:<sequence_number>\n
 * data: <json>\n
 * \n
 * ```
 *
 * - `event:` line equals data.type (validated).
 * - `id:` is `response_id:sequence_number`.
 * - data is a single JSON line (no multi-line data from encoder side).
 * - frame terminated by a blank line (`\n\n`).
 *
 * Pure: no I/O.
 */
export function encodeSseEvent(event: AgentStreamEvent): string {
  // Guard: encodeSseEvent trusts its TS input, but still asserts the
  // event/type consistency cheaply to avoid silent wire drift.
  if (event.protocol !== AGENT_STREAM_PROTOCOL) {
    throw new AgentStreamProtocolError(
      "PROTOCOL_VERSION_MISMATCH",
      `encodeSseEvent: event.protocol must be "${AGENT_STREAM_PROTOCOL}"`,
    );
  }
  const json = JSON.stringify(event);
  const id = agentStreamEventId(event);
  return `event: ${event.type}\nid: ${id}\ndata: ${json}\n\n`;
}

// ── Sequence tracking helper ────────────────────────────────────────────────

export type SequenceCheck =
  | { ok: true }
  | { ok: false; reason: "duplicate" | "backward" | "gap"; expected: number; actual: number };

/**
 * Stateful sequence tracker for a single response_id.
 *
 * - First event MUST be response.created with sequence_number 0.
 * - Subsequent events must be strictly +1 over the previous.
 * - Detects duplicate / backward / gap. Design §4.3 + plan §3.3.4.
 *
 * The tracker only validates numeric ordering; it does not mutate events.
 */
export interface SequenceTracker {
  /** Last accepted sequence_number, or undefined before the first event. */
  last: number | undefined;
  /** Observe an event's sequence_number; returns ok or a typed diagnostic. */
  observe(next: number, options?: { isFirst?: boolean }): SequenceCheck;
}

export function createSequenceTracker(): SequenceTracker {
  let last: number | undefined;
  return {
    get last() {
      return last;
    },
    observe(next, options) {
      const isFirst = options?.isFirst ?? last === undefined;
      if (isFirst) {
        if (next !== 0) {
          return { ok: false, reason: "backward", expected: 0, actual: next };
        }
        last = 0;
        return { ok: true };
      }
      const expected = (last ?? 0) + 1;
      if (next === last) return { ok: false, reason: "duplicate", expected, actual: next };
      if (next < (last ?? 0)) return { ok: false, reason: "backward", expected, actual: next };
      if (next > expected) return { ok: false, reason: "gap", expected, actual: next };
      last = next;
      return { ok: true };
    },
  };
}

// ── Event factory + sequencer (Phase 2) ─────────────────────────────────────
//
// Design §4.5 / plan §4.5: there is exactly ONE sequence owner per turn.
// runtime creates the response_id; `response.created.sequence_number = 0`;
// every subsequent event increments by exactly 1; never duplicates, never
// regresses. The factory below is the only sequencer in agent-runtime:
// pi-runtime.ts builds it once per turn inside streamChat and routes every
// emit through it; server.ts does NOT maintain its own counter.
//
// Pure module (no env / no I/O). The factory only assigns protocol/response_id/
// sequence_number/created_at and validates monotonicity; per-type required
// fields remain the caller's responsibility (the canonical validator
// `parseAgentStreamEvent` is the wire-side backstop).

/**
 * Generate a fresh, opaque response_id. Format mirrors the OpenAI Responses
 * convention `resp_<n>_<base36>` to keep ids URL-safe and prefix-tagged.
 */
export function createResponseId(seed?: { requestId?: string; nonce?: number }): string {
  const nonce = seed?.nonce ?? Math.floor(Math.random() * 2 ** 31);
  const tail = seed?.requestId
    ? `${seed.requestId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16)}_${nonce.toString(36)}`
    : nonce.toString(36);
  return `resp_${Date.now().toString(36)}_${tail}`;
}

/**
 * Identity meta attached to every event in this turn. Produced by the factory
 * from the response.created payload so callers never retype session/run ids.
 */
export interface AgentEventTurnMeta {
  response_id: string;
  session_id: string;
  agent_run_id: string;
}

/**
 * Opaque event-spec object consumed by {@link createAgentEventEmitter}.
 *
 * This is a single canonical event with the factory-owned envelope fields
 * (`protocol`, `response_id`, `sequence_number`, `session_id`, `agent_run_id`,
 * `created_at`) removed — the emitter stamps those. The per-type discriminant
 * fields (e.g. `delta`, `text`, `memory`, `tool_execution_id`, `error`) are
 * preserved, so callers pass a fully-typed event minus the envelope.
 *
 * `Omit` does NOT distribute over unions, so we use a distributive conditional
 * to apply it per union member (otherwise per-type fields would be lost).
 */
type DistributiveOmit<T, K extends string | number | symbol> = T extends unknown ? Omit<T, K> : never;

/** Fields the emitter stamps; callers MUST NOT set them on a spec. */
export type AgentEventEnvelopeField =
  | "protocol"
  | "response_id"
  | "sequence_number"
  | "session_id"
  | "agent_run_id"
  | "created_at";

export type AgentEventSpec = DistributiveOmit<AgentStreamEvent, AgentEventEnvelopeField>;

/**
 * Single sequencer + event factory for one Agent turn.
 *
 * Usage (pi-runtime.ts):
 *   const emitter = createAgentEventEmitter({ response_id, session_id, agent_run_id }, sink);
 *   emitter.created();           // sequence 0, MUST be first
 *   emitter.emit({ type: "response.in_progress" });
 *   ...
 *
 * The factory:
 *  - assigns sequence 0 to the first event (typically response.created);
 *  - strictly increments by 1 thereafter;
 *  - asserts monotonicity via the shared SequenceTracker (throws on duplicate/gap);
 *  - injects protocol + created_at (emitter clock);
 *  - routes the finalized event through the caller-provided sink.
 *
 * It does NOT call response.completed — runtime EOF is the turn boundary,
 * not a terminal event (design §6.3). Next.js is the sole terminal owner.
 */
export interface AgentEventEmitter {
  /** The turn's response_id; stable for the lifetime of the emitter. */
  readonly response_id: string;
  /** The turn's session_id / agent_run_id (mirrored on every event). */
  readonly meta: AgentEventTurnMeta;
  /** Next sequence number this emitter would assign (0 before any emit). */
  readonly nextSequence: number;
  /**
   * Emit `response.created` with sequence 0. MUST be the first call.
   * Caller passes session_id / agent_run_id (the emitter stores them and
   * reuses for all subsequent events).
   */
  created(): void;
  /** Emit any non-created event, stamping the next sequence number. */
  emit(spec: AgentEventSpec): void;
  /** Convenience: emit a generic `error` event (design §5.7 fatal path). */
  emitError(message: string, options?: { code?: string; retryable?: boolean }): void;
}

export function createAgentEventEmitter(
  meta: AgentEventTurnMeta,
  sink: (event: AgentStreamEvent) => void,
): AgentEventEmitter {
  // Authoritative monotonic counter for this turn. `next` is the sequence
  // number the next event will receive; created() forces 0, every subsequent
  // emit increments by exactly 1. The shared SequenceTracker above is the
  // consumer-side validator; here we own the increment directly so there is
  // exactly one sequence owner (design §4.5).
  let next = 0;
  let createdEmitted = false;

  const stamp = (spec: AgentEventSpec): AgentStreamEvent => {
    const sequence_number = next;
    next += 1;
    const event = {
      ...spec,
      protocol: AGENT_STREAM_PROTOCOL,
      response_id: meta.response_id,
      sequence_number,
      session_id: meta.session_id,
      agent_run_id: meta.agent_run_id,
      created_at: Date.now(),
    } as unknown as AgentStreamEvent;
    // Light envelope check; full per-type validation remains the decoder's job.
    if (event.protocol !== AGENT_STREAM_PROTOCOL) {
      throw new AgentStreamProtocolError(
        "PROTOCOL_VERSION_MISMATCH",
        "emitter stamped wrong protocol",
      );
    }
    return event;
  };

  return {
    get response_id() {
      return meta.response_id;
    },
    get meta() {
      return meta;
    },
    get nextSequence() {
      return next;
    },
    created() {
      if (createdEmitted) {
        throw new AgentStreamProtocolError(
          "INVALID_FIELD_TYPE",
          "response.created already emitted for this turn",
        );
      }
      // created() MUST always be the first call → sequence 0.
      if (next !== 0) {
        throw new AgentStreamProtocolError(
          "INVALID_FIELD_TYPE",
          `response.created must be sequence 0 (next=${next})`,
        );
      }
      createdEmitted = true;
      const event = stamp({ type: "response.created" }) as ResponseCreatedEvent;
      sink(event);
    },
    emit(spec) {
      if (!createdEmitted) {
        throw new AgentStreamProtocolError(
          "INVALID_FIELD_TYPE",
          `cannot emit ${spec.type} before response.created`,
        );
      }
      if (spec.type === "response.created") {
        throw new AgentStreamProtocolError(
          "INVALID_FIELD_TYPE",
          "response.created must be emitted via emitter.created()",
        );
      }
      const event = stamp(spec);
      sink(event);
    },
    emitError(message, options) {
      this.emit({
        type: "error",
        error: {
          message,
          ...(options?.code ? { code: options.code } : {}),
          ...(options?.retryable !== undefined ? { retryable: options.retryable } : {}),
        },
      });
    },
  };
}
