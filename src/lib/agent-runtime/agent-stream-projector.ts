/**
 * Phase 3 persistence projector (design §7.4 / plan §5.3).
 *
 * Folds canonical {@link AgentStreamEvent}s into a per-turn aggregate that is
 * shape-compatible with the existing session persistence DTO
 * (`AgentChatMessageRecord` / `AgentTimelineItem`), so a page refresh can fully
 * reconstruct the timeline — including the needs-user-confirmation card.
 *
 * This replaces the legacy inline `handleEvent` from the chat-stream route. The
 * one-shot fix bundled in (design §7.4): the old handleEvent dropped
 * `tool_error.code` and `targetIntent`, so the confirmation card only worked
 * while the live stream was open and was lost on refresh. This projector
 * persists `error.code` + `target_intent` (recovered as timeline `targetIntent`)
 * on every tool failure, runtime or synthetic.
 *
 * Pure module:
 *  - no I/O, no Prisma, no fetch, no env
 *  - mutates only the aggregate it is given
 *  - canonical-event-only (SSE transport). The runner is the sole place that
 *    decides SSE-vs-NDJSON framing; by the time events reach the projector they
 *    are already parsed canonical `AgentStreamEvent` objects (runtime emits
 *    canonical objects under both transports after Phase 2).
 */
import type { AgentStreamEvent } from "../../../agent-runtime/src/stream-protocol";
import type { AgentTimelineItem, AgentViewIntent } from "./types";

/**
 * Per-turn persistence aggregate. Field names mirror the existing route's
 * locals so `createAgentChatMessage` / `updateAgentChatSession` inputs stay
 * byte-compatible with the pre-Phase-3 behaviour.
 */
export interface AgentTurnAggregate {
  /** Concatenated assistant text deltas; calibrated by output_text.done. */
  assistantContent: string;
  /** "done" | "error" — flips to "error" on tool_error / response.failed / error. */
  assistantState: "done" | "error";
  /** Ordered timeline; same shape UI restores from session DTO. */
  assistantTimeline: AgentTimelineItem[];
  /** Last `scimanage.usage.updated` payload (or completed.usage). */
  tokenUsage: Record<string, unknown> | null;
  /**
   * Latest compact summary text captured from `context_compaction.completed`.
   * Persisted to `session.compactSummary`; NOT placed on the wire (design §5.4).
   */
  compactSummaryUpdate: string | null;
}

export function createAgentTurnAggregate(): AgentTurnAggregate {
  return {
    assistantContent: "",
    assistantState: "done",
    assistantTimeline: [],
    tokenUsage: null,
    compactSummaryUpdate: null,
  };
}

// ── timeline helpers (ported verbatim from the legacy route so persistence
//    shape does not drift; only the event-input layer changed) ──────────────

/**
 * Stable id for the per-turn compaction timeline row. Canonical compaction
 * events do not carry an id, so we use a fixed string per turn (the runtime
 * emits at most one auto-compaction per turn). Mirrors the legacy route which
 * keyed by a per-compaction constant id.
 */
const COMPACT_TIMELINE_ID = "context_compaction";

function markRunningThinkingDone(timeline: AgentTimelineItem[]) {
  for (const item of timeline) {
    if (item.kind === "thinking" && item.status === "running") {
      item.status = "done";
    }
  }
}

function upsertTextTimelineItem(timeline: AgentTimelineItem[], delta: string) {
  // 只与「最后一个」text 段合并：工具调用之后的新文本必须开新段，
  // 否则最终回答会被并回工具调用之前的第一段，渲染顺序颠倒。
  const last = timeline[timeline.length - 1];
  if (last && last.kind === "text") {
    last.content += delta;
    return;
  }
  // Text after thinking should close the thinking phase for chronological final view.
  markRunningThinkingDone(timeline);
  const seq = timeline.filter((item) => item.kind === "text").length;
  timeline.push({ id: `assistant_text_${seq}`, kind: "text", content: delta, status: "done" });
}

function upsertThinkingTimelineItem(timeline: AgentTimelineItem[], id: string, label: string) {
  // Design §5.2 / §7.4: thinking 原始正文不进 wire、不持久化。activity 事件只
  // 携带 label，所以这里只记录一个 running/done 的 thinking 占位行（无 content）。
  const existing = timeline.find((item) => item.kind === "thinking" && item.id === id);
  if (existing && existing.kind === "thinking") {
    existing.status = "running";
    return;
  }
  markRunningThinkingDone(timeline);
  timeline.push({ id, kind: "thinking", content: label, status: "running" });
}

function completeThinkingTimelineItem(timeline: AgentTimelineItem[], id: string) {
  const existing = timeline.find((item) => item.kind === "thinking" && item.id === id);
  if (existing && existing.kind === "thinking") {
    existing.status = "done";
  }
}

type ToolTimelineItem = Extract<AgentTimelineItem, { kind: "tool" }>;

function upsertToolTimelineItem(
  timeline: AgentTimelineItem[],
  id: string,
  patch: Partial<ToolTimelineItem> & { toolName: string; label: string },
) {
  const existing = timeline.find((item) => item.kind === "tool" && item.id === id);
  if (existing && existing.kind === "tool") {
    Object.assign(existing, patch);
    return;
  }
  markRunningThinkingDone(timeline);
  timeline.push({
    id,
    kind: "tool",
    toolName: patch.toolName,
    label: patch.label,
    status: patch.status || "running",
    content: patch.content,
    input: patch.input,
    output: patch.output,
    error: patch.error,
    code: patch.code,
    targetIntent: patch.targetIntent,
  });
}

type CompactTimelineItem = Extract<AgentTimelineItem, { kind: "compact" }>;

function upsertCompactTimelineItem(
  timeline: AgentTimelineItem[],
  id: string,
  patch: Partial<CompactTimelineItem> & { content?: string },
) {
  const existing = timeline.find((item) => item.kind === "compact" && item.id === id);
  if (existing && existing.kind === "compact") {
    Object.assign(existing, patch);
    return;
  }
  timeline.push({
    id,
    kind: "compact",
    content: patch.content || "",
    status: patch.status || "running",
    tokensBefore: patch.tokensBefore,
    tokensAfter: patch.tokensAfter,
  });
}

/**
 * Fold one canonical event into the aggregate. Idempotent w.r.t. duplicate
 * sequence numbers: timeline upserts are keyed by stable id, text deltas are
 * only applied once by the runner's sequence tracker, but this function is also
 * safe if called twice with the same event (tool/compact/thinking are upserts;
 * text delta would double-append — the runner dedupes upstream).
 *
 * Returns the aggregate for convenience.
 */
export function projectAgentStreamEvent(agg: AgentTurnAggregate, event: AgentStreamEvent): AgentTurnAggregate {
  switch (event.type) {
    case "response.created":
    case "response.in_progress":
      // No persistence projection: these only drive UI "waiting" placeholder.
      // The runner yields them to the route untouched.
      return agg;

    case "response.output_text.delta":
      agg.assistantContent += event.delta;
      upsertTextTimelineItem(agg.assistantTimeline, event.delta);
      return agg;

    case "response.output_text.done":
      // Final calibrated text — overrides concatenated deltas (design §5.1).
      agg.assistantContent = event.text;
      return agg;

    case "scimanage.activity.started":
      upsertThinkingTimelineItem(agg.assistantTimeline, event.activity_id, event.label);
      return agg;

    case "scimanage.activity.completed":
      completeThinkingTimelineItem(agg.assistantTimeline, event.activity_id);
      return agg;

    case "scimanage.tool_execution.started":
      upsertToolTimelineItem(agg.assistantTimeline, event.tool_execution_id, {
        toolName: event.tool_name,
        label: event.label,
        status: "running",
        input: event.input,
      });
      return agg;

    case "scimanage.tool_execution.completed":
      upsertToolTimelineItem(agg.assistantTimeline, event.tool_execution_id, {
        toolName: event.tool_name,
        label: event.label,
        status: "done",
        output: event.output,
      });
      return agg;

    case "scimanage.tool_execution.failed": {
      // §7.4 one-shot fix: persist error.code AND target_intent. A single tool
      // failure does NOT flip the whole turn to error (design §5.7) — the agent
      // may explain the failure and complete normally. We only mark this item.
      upsertToolTimelineItem(agg.assistantTimeline, event.tool_execution_id, {
        toolName: event.tool_name,
        label: event.label,
        status: "error",
        error: event.error.message,
        ...(event.error.code ? { code: event.error.code } : {}),
        ...(event.target_intent ? { targetIntent: event.target_intent } : {}),
      });
      return agg;
    }

    case "scimanage.context_compaction.started":
      // Stable per-turn id so completed updates the same row. Canonical events
      // do not carry a compaction id, so we use a fixed string (one compaction
      // row per turn — matches the legacy route which keyed by event.id that was
      // itself a per-compaction constant).
      upsertCompactTimelineItem(agg.assistantTimeline, COMPACT_TIMELINE_ID, {
        status: "running",
      });
      return agg;

    case "scimanage.context_compaction.completed": {
      // Design §5.4: summary 正文默认不进 wire；runtime completed 不携带
      // summary。若需要持久化 summary，runner 通过 setCompactSummary 单独
      // 捕获（NDJSON 兼容路径或未来带 summary 的扩展）。这里只记录 token + 状态。
      upsertCompactTimelineItem(agg.assistantTimeline, COMPACT_TIMELINE_ID, {
        status: "done",
        tokensBefore: event.tokens_before,
        tokensAfter: event.tokens_after,
      });
      return agg;
    }

    case "scimanage.context_compaction.warning":
      // No timeline projection — UI may surface as a transient notice. Persist
      // nothing; the runner still yields it.
      return agg;

    case "scimanage.memory.suggested": {
      const memory = event.memory;
      agg.assistantTimeline.push({
        id: typeof memory.id === "string" ? memory.id : `memory_${agg.assistantTimeline.length}`,
        kind: "memory",
        content: typeof memory.content === "string" ? memory.content : "memory suggestion",
        status: "suggested",
        memoryId: typeof memory.id === "string" ? memory.id : undefined,
      });
      return agg;
    }

    case "scimanage.view_intent.created": {
      const intent = event.intent;
      agg.assistantTimeline.push({
        id: typeof intent.id === "string" ? intent.id : `view_${agg.assistantTimeline.length}`,
        kind: "view",
        intent: intent as unknown as AgentViewIntent,
        status: "suggested",
      });
      return agg;
    }

    case "scimanage.proactive_task.suggested": {
      const task = event.task;
      agg.assistantTimeline.push({
        id: typeof task.id === "string" ? task.id : `proactive_${agg.assistantTimeline.length}`,
        kind: "proactive",
        content: typeof task.title === "string" ? task.title : "proactive task suggestion",
        status: "suggested",
        taskId: typeof task.id === "string" ? task.id : undefined,
      });
      return agg;
    }

    case "scimanage.usage.updated":
      agg.tokenUsage = event.usage as Record<string, unknown>;
      return agg;

    case "response.completed":
      // Terminal success — runner emits this only AFTER persistence. If a
      // completed carries usage, fold it (final authority over per-event usage).
      if (event.usage) {
        agg.tokenUsage = event.usage as Record<string, unknown>;
      }
      return agg;

    case "response.failed":
    case "error":
      // Protocol-level failure flips the whole turn. Design §5.7: persistence
      // failure / runtime crash → response.failed; this is the only path that
      // marks assistantState = "error".
      agg.assistantState = "error";
      return agg;

    default: {
      // exhaustiveness guard — if a new event type is added to the union
      // without a projection, this compile-time never forces an explicit case.
      const _exhaustive: never = event;
      void _exhaustive;
      return agg;
    }
  }
}

/**
 * Normalize the timeline for persistence: any still-running thinking/tool/compact
 * item is closed to "done" so a refresh never renders a perpetual spinner.
 * Mirrors the legacy route's `normalizeTimeline`.
 */
export function normalizeTimelineForPersistence(timeline: AgentTimelineItem[]): AgentTimelineItem[] {
  return timeline.map((item) => {
    if (item.kind === "thinking") {
      return { ...item, status: item.status === "running" ? "done" : item.status };
    }
    if (item.kind === "tool" || item.kind === "compact") {
      return { ...item, status: item.status === "running" ? "done" : item.status };
    }
    return item;
  });
}

/**
 * Runner-only hook for the NDJSON compat path: legacy `compact_end` carried the
 * summary text on the wire. The runner uses this to feed the summary into the
 * aggregate without inventing a new event. Not used on the pure SSE path
 * (where the summary never crosses the wire — design §5.4).
 */
export function setCompactSummary(agg: AgentTurnAggregate, summary: string): void {
  const trimmed = summary.trim();
  if (trimmed) {
    agg.compactSummaryUpdate = trimmed;
  }
}
