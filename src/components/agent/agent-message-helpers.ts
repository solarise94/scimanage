/** Shared helpers for Agent message rendering (desktop + mobile). */

import type {
  AgentChatMessageAttachment,
  AgentTimelineItem,
  AgentViewIntent,
} from "@/lib/agent-runtime/types";
import type { AgentStreamEvent } from "../../../agent-runtime/src/stream-protocol";
import type { AgentChatMessage } from "./chat-panel";

/** Collapse model-emitted leading blank lines that inflate prose into a white slab. */
export function normalizeAssistantText(content: string) {
  return content.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");
}

/**
 * 是否显示 assistant 消息的复制 / 分享操作行（docs Part 2 §2.3）。
 *
 * 与时间戳行同一判定口径：
 * - 非 streaming（含 legacy 的 state===undefined）；
 * - normalizeAssistantText 非空（排除「只跑工具没产出文字」的纯卡片消息）。
 *
 * 抽成纯函数便于双端共享 + 单测覆盖（streaming / legacy undefined / 空 content）。
 */
export function shouldShowAssistantActions(message: { state?: string; content?: string }): boolean {
  return message.state !== "streaming" && Boolean(normalizeAssistantText(message.content || ""));
}

// ---------------------------------------------------------------------------
// Agent runtime event → AgentChatMessage / timeline upsert helpers.
//
// These were previously duplicated (and had drifted) in agent-workbench.tsx
// (desktop) and agent-mobile-shell.tsx (mobile).  Both shells now import them
// from here so a single edit propagates to both surfaces.
// ---------------------------------------------------------------------------

/** Sentinel id for the initial "waiting" thinking row shown at message_start. */
export const INITIAL_THINKING_ID = "runtime_waiting";

/**
 * Build an AgentChatMessage. Module-scope (no React hooks) so the
 * react-hooks/purity rule does not apply even though it calls Date.now /
 * Math.random.  Mirrors the prior module-scope factory in each shell.
 */
export function createMessage(
  role: "user" | "assistant",
  content: string,
  extra: Partial<AgentChatMessage> = {},
): AgentChatMessage {
  return {
    id: `${role}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

/** Create the empty streaming assistant placeholder with a running thinking row. */
export function createStreamingAssistantMessage(): AgentChatMessage {
  return createMessage("assistant", "", {
    state: "streaming",
    timeline: [{ id: INITIAL_THINKING_ID, kind: "thinking", content: "", status: "running" }],
  });
}

/** Map a stored session message record to the UI AgentChatMessage shape. */
export function mapSessionMessage<T extends {
  id: string;
  role: string;
  content: string;
  state: string;
  timeline: AgentTimelineItem[];
  createdAt: string;
  attachments?: AgentChatMessageAttachment[];
}>(message: T): AgentChatMessage {
  return {
    id: message.id,
    role: message.role === "user" ? "user" : "assistant",
    content: message.content,
    createdAt: message.createdAt,
    state: message.state,
    timeline: Array.isArray(message.timeline) ? message.timeline : [],
    ...(Array.isArray(message.attachments) && message.attachments.length > 0
      ? { attachments: message.attachments }
      : {}),
  };
}

/** Flip every still-running thinking row to "done". Mutates the array items. */
export function markRunningThinkingDone(timeline: AgentTimelineItem[]) {
  for (const item of timeline) {
    if (item.kind === "thinking" && item.status === "running") {
      item.status = "done";
    }
  }
}

/** End any running thinking rows and optionally patch the assistant message (error / cancel / fallback). */
export function finishRunningTimeline(
  messages: AgentChatMessage[],
  messageId: string,
  patch?: Partial<Pick<AgentChatMessage, "state" | "content">>,
) {
  return messages.map((message) => {
    if (message.id !== messageId) return message;
    const timeline = [...(message.timeline ?? [])];
    markRunningThinkingDone(timeline);
    return { ...message, ...patch, timeline };
  });
}

/** Copy-on-write upsert into one assistant message's timeline. */
export function upsertTimeline(
  messages: AgentChatMessage[],
  messageId: string,
  updater: (timeline: AgentTimelineItem[]) => void,
) {
  return messages.map((message) => {
    if (message.id !== messageId) return message;
    const timeline = [...(message.timeline ?? [])];
    updater(timeline);
    return { ...message, timeline };
  });
}

/** Append/merge assistant text into the timeline, preserving chronological order. */
export function upsertTextItem(timeline: AgentTimelineItem[], delta: string) {
  // 只与「最后一个」text 段合并：工具调用之后的新文本必须开新段，
  // 否则最终回答会被并回工具调用之前的第一段，渲染顺序颠倒。
  const last = timeline[timeline.length - 1];
  if (last && last.kind === "text") {
    last.content = normalizeAssistantText(`${last.content || ""}${delta}`);
    return;
  }
  markRunningThinkingDone(timeline);
  const seq = timeline.filter((item) => item.kind === "text").length;
  timeline.push({ id: `assistant_text_${seq}`, kind: "text", content: normalizeAssistantText(delta), status: "done" });
}

/** Append/merge a thinking chunk. The initial placeholder is not force-finalized. */
export function upsertThinkingItem(timeline: AgentTimelineItem[], id: string, delta: string) {
  if (id !== INITIAL_THINKING_ID) {
    markRunningThinkingDone(timeline);
  }
  const existing = timeline.find((item) => item.kind === "thinking" && item.id === id);
  if (existing && existing.kind === "thinking") {
    existing.content = `${existing.content || ""}${delta}`;
    existing.status = "running";
    return;
  }
  timeline.push({ id, kind: "thinking", content: delta, status: "running" });
}

export function upsertToolItem(
  timeline: AgentTimelineItem[],
  id: string,
  patch: Partial<Extract<AgentTimelineItem, { kind: "tool" }>> & { toolName: string; label: string },
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
    input: patch.input,
    output: patch.output,
    error: patch.error,
    ...(patch.code ? { code: patch.code } : {}),
    ...(patch.targetIntent ? { targetIntent: patch.targetIntent } : {}),
  });
}

export function upsertCompactItem(
  timeline: AgentTimelineItem[],
  id: string,
  patch: Partial<Extract<AgentTimelineItem, { kind: "compact" }>>,
) {
  const existing = timeline.find((item) => item.kind === "compact" && item.id === id);
  if (existing && existing.kind === "compact") {
    Object.assign(existing, patch);
    return;
  }
  timeline.push({
    id,
    kind: "compact",
    content: typeof patch.content === "string" ? patch.content : "",
    status: patch.status || "running",
    tokensBefore: patch.tokensBefore,
    tokensAfter: patch.tokensAfter,
  });
}

/**
 * Fold one canonical Agent stream event into the current message list. Pure-ish:
 * returns a new messages array (old items are shallow-copied; timeline item
 * mutation is intentional and matches prior behaviour). Directly consumes the
 * canonical {@link AgentStreamEvent} union — no adapter in between
 * (design §9.3 / plan §6.4).
 *
 * Mapping (design §5.8 / §9.3):
 *   response.created / response.in_progress → waiting placeholder
 *   response.output_text.delta              → text append
 *   response.output_text.done               → final text calibration (NOT a success terminal)
 *   scimanage.activity.started/completed    → thinking row (no raw reasoning body)
 *   scimanage.tool_execution.started/completed/failed → tool timeline
 *   scimanage.context_compaction.*          → compaction status row
 *   scimanage.memory.suggested              → memory card
 *   scimanage.view_intent.created           → view-intent card
 *   scimanage.proactive_task.suggested      → proactive card
 *   response.completed                      → assistant done (SOLE success terminal)
 *   response.failed                         → assistant error (SOLE failure terminal)
 */
export function appendAgentStreamEvent(
  messages: AgentChatMessage[],
  assistantId: string,
  event: AgentStreamEvent,
) {
  if (event.type === "response.created" || event.type === "response.in_progress") {
    // 等待中占位：保留旧 message_start 等价的初始 thinking 行（无正文）。
    return upsertTimeline(messages, assistantId, (timeline) => {
      upsertThinkingItem(timeline, INITIAL_THINKING_ID, "");
    });
  }

  if (event.type === "response.output_text.delta") {
    return messages.map((message) => {
      if (message.id !== assistantId) return message;
      const timeline = [...(message.timeline ?? [])];
      upsertTextItem(timeline, event.delta);
      return {
        ...message,
        content: `${message.content}${event.delta}`,
        timeline,
      };
    });
  }

  if (event.type === "response.output_text.done") {
    // 最终文本校准：覆盖累计文本，但**不**作为成功终态（design §5.8）。
    return messages.map((message) => {
      if (message.id !== assistantId) return message;
      const timeline = [...(message.timeline ?? [])];
      markRunningThinkingDone(timeline);
      const content = normalizeAssistantText(event.text || message.content || "");
      // 流式分段已在时间线里；仅在完全没收到文本增量时用最终 content 补一段。
      if (content && !timeline.some((item) => item.kind === "text")) {
        timeline.push({ id: "assistant_text_0", kind: "text", content, status: "done" });
      }
      return { ...message, content, timeline };
    });
  }

  if (event.type === "scimanage.activity.started") {
    // activity → thinking 占位行；activity 不携带原始推理正文（design §5.2）。
    return upsertTimeline(messages, assistantId, (timeline) => {
      upsertThinkingItem(timeline, event.activity_id, "");
    });
  }

  if (event.type === "scimanage.activity.completed") {
    return upsertTimeline(messages, assistantId, (timeline) => {
      const existing = timeline.find(
        (item) => item.kind === "thinking" && item.id === event.activity_id,
      );
      if (existing && existing.kind === "thinking") existing.status = "done";
      else markRunningThinkingDone(timeline);
    });
  }

  if (event.type === "scimanage.tool_execution.started") {
    return upsertTimeline(messages, assistantId, (timeline) => {
      upsertToolItem(timeline, event.tool_execution_id, {
        toolName: event.tool_name,
        label: event.label || event.tool_name,
        status: "running",
        input: event.input,
      });
    });
  }

  if (event.type === "scimanage.tool_execution.completed") {
    return upsertTimeline(messages, assistantId, (timeline) => {
      upsertToolItem(timeline, event.tool_execution_id, {
        toolName: event.tool_name,
        label: event.label || event.tool_name,
        status: "done",
        output: event.output,
      });
    });
  }

  if (event.type === "scimanage.tool_execution.failed") {
    return upsertTimeline(messages, assistantId, (timeline) => {
      upsertToolItem(timeline, event.tool_execution_id, {
        toolName: event.tool_name,
        label: event.label || event.tool_name,
        status: "error",
        error: event.error.message || "Tool execution failed",
        // §6.5：透传 NEEDS_USER_CONFIRMATION 的 error.code + target_intent →
        // timeline.code + targetIntent，渲染 needs-user-confirmation 卡片。
        ...(event.error.code ? { code: event.error.code } : {}),
        ...(event.target_intent ? { targetIntent: event.target_intent } : {}),
      });
    });
  }

  if (event.type === "scimanage.context_compaction.started") {
    // Canonical compaction 事件无 id；按 projector 一致使用固定 per-turn id。
    return upsertTimeline(messages, assistantId, (timeline) => {
      upsertCompactItem(timeline, COMPACT_TIMELINE_ID, { status: "running" });
    });
  }

  if (event.type === "scimanage.context_compaction.completed") {
    // design §6.7：compact 至少显示「压缩完成」状态行；不显示 summary 正文是明确接受的变化。
    return upsertTimeline(messages, assistantId, (timeline) => {
      upsertCompactItem(timeline, COMPACT_TIMELINE_ID, {
        content: "上下文已压缩",
        status: "done",
        tokensBefore: event.tokens_before,
        tokensAfter: event.tokens_after,
      });
    });
  }

  if (event.type === "scimanage.context_compaction.warning") {
    // 不展开到独立 timeline 段；保留为对 compact 行的无操作（避免噪音）。
    return messages;
  }

  if (event.type === "scimanage.memory.suggested") {
    return upsertTimeline(messages, assistantId, (timeline) => {
      const memory = event.memory;
      timeline.push({
        id: typeof memory.id === "string" ? memory.id : `memory_${timeline.length}`,
        kind: "memory",
        content: typeof memory.content === "string" ? memory.content : "已保存 memory",
        status: "saved",
        memoryId: typeof memory.id === "string" ? memory.id : undefined,
      });
    });
  }

  if (event.type === "scimanage.view_intent.created") {
    return upsertTimeline(messages, assistantId, (timeline) => {
      const intent = event.intent as Record<string, unknown> | undefined;
      timeline.push({
        id: typeof intent?.id === "string" ? intent.id : `view_${timeline.length}`,
        kind: "view",
        intent: {
          type: typeof intent?.type === "string"
            ? (intent.type as AgentViewIntent["type"])
            : "navigate",
          route: typeof intent?.route === "string" ? intent.route : undefined,
          entityType: typeof intent?.entityType === "string"
            ? (intent.entityType as AgentViewIntent["entityType"])
            : undefined,
          entityId: typeof intent?.entityId === "string" ? intent.entityId : undefined,
          panel: typeof intent?.panel === "string" ? intent.panel : undefined,
          filters: intent?.filters && typeof intent.filters === "object"
            ? (intent.filters as AgentViewIntent["filters"])
            : undefined,
          label: typeof intent?.label === "string" ? intent.label : "视图建议",
          reason: typeof intent?.reason === "string" ? intent.reason : undefined,
        },
        status: "suggested",
      });
    });
  }

  if (event.type === "scimanage.proactive_task.suggested") {
    return upsertTimeline(messages, assistantId, (timeline) => {
      const task = event.task as Record<string, unknown> | undefined;
      timeline.push({
        id: typeof task?.id === "string" ? task.id : `proactive_${timeline.length}`,
        kind: "proactive",
        content: typeof task?.title === "string" ? task.title : "已安排主动提醒",
        status: "scheduled",
        taskId: typeof task?.id === "string" ? task.id : undefined,
      });
    });
  }

  if (event.type === "scimanage.usage.updated") {
    // usage 不进 timeline（与 projector 行为一致）。
    return messages;
  }

  if (event.type === "response.completed") {
    // 唯一成功终态：收尾所有 running 段，状态置 done。
    return messages.map((message) => {
      if (message.id !== assistantId) return message;
      const timeline = [...(message.timeline ?? [])];
      markRunningThinkingDone(timeline);
      for (const item of timeline) {
        if ((item.kind === "tool" || item.kind === "compact") && item.status === "running") {
          item.status = "done";
        }
      }
      const content = normalizeAssistantText(message.content || "");
      return { ...message, content, state: "done" as const, timeline };
    });
  }

  if (event.type === "response.failed" || event.type === "error") {
    return messages.map((message) => {
      if (message.id !== assistantId) return message;
      const timeline = [...(message.timeline ?? [])];
      markRunningThinkingDone(timeline);
      return {
        ...message,
        state: "error" as const,
        content: message.content || event.error?.message || "Agent runtime failed",
        timeline,
      };
    });
  }

  // unknown scimanage.* / future types: ignore (consumer logs upstream).
  return messages;
}

/**
 * Per-turn compaction timeline id — canonical compaction events carry no id, so
 * we use a fixed string per turn (matches the persistence projector).
 */
const COMPACT_TIMELINE_ID = "context_compaction";

/**
 * Backwards-compatible alias for desktop/mobile imports. Implementation is the
 * canonical `appendAgentStreamEvent` (Phase 5: SSE is the only transport).
 */
export const appendRuntimeEvent = appendAgentStreamEvent;

/**
 * P1-3 UI 接线：判断一个 tool timeline item 是否应渲染为「需要用户确认」卡片，
 * 而非默认的红色错误行。
 *
 * 命中条件：item 是工具项 + 状态 error + code === "NEEDS_USER_CONFIRMATION"
 * （由 runtime tool_error 事件透传，经 appendRuntimeEvent 写入 timeline）。
 * 缺 targetIntent 仍渲染卡片（按钮禁用 + 文案提示），但不崩溃。
 *
 * 类型谓词收窄到 tool 变体（保留 code/targetIntent 可选字段），便于渲染分支读取。
 */
export function shouldRenderNeedsConfirmation(
  item: AgentTimelineItem,
): item is Extract<AgentTimelineItem, { kind: "tool" }> & { status: "error"; code?: string } {
  return item.kind === "tool" && item.status === "error" && item.code === "NEEDS_USER_CONFIRMATION";
}

/** Prefer a short human message when tool errors are Pi-wrapped JSON blobs. */
export function humanizeToolError(error: string) {
  const raw = error.trim();
  if (!raw) return "工具执行失败";

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.error === "string" && obj.error.trim()) return obj.error.trim();
      if (Array.isArray(obj.content)) {
        const texts = obj.content
          .map((part) => {
            if (!part || typeof part !== "object") return "";
            const text = (part as Record<string, unknown>).text;
            return typeof text === "string" ? text.trim() : "";
          })
          .filter(Boolean);
        if (texts.length > 0) return texts.join("\n");
      }
    }
  } catch {
    // not JSON — fall through
  }

  const match = raw.match(/"text"\s*:\s*"([^"]+)"/);
  if (match?.[1]) {
    try {
      return JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return match[1];
    }
  }

  if (raw.includes("bridge_connect_failed") || raw.includes("fetch failed")) {
    return "业务工具服务暂时不可达，请稍后重试";
  }

  return raw;
}

export function formatMessageTime(dateStr: string) {
  return new Date(dateStr).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function isSameMessageDay(a: string, b: string) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

export function formatMessageDateLabel(dateStr: string) {
  const date = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return "今天";
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return date.toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
}
