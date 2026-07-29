// Phase 5: the canonical Agent SSE event union lives in
// agent-runtime/src/stream-protocol.ts and is the single source of truth. SSE is
// the only wire transport; the legacy NDJSON wire union was deleted in Phase 5
// (plan §7). The UI reducer, invoice queue, desktop and mobile all consume
// canonical `AgentStreamEvent` directly.
// Type-only import — no runtime coupling, verified by `npm run typecheck:app`.
import type { AgentStreamEvent } from "../../../agent-runtime/src/stream-protocol";

/**
 * Canonical SSE event contract re-exported for the Next.js codebase.
 */
export type { AgentStreamEvent };

export interface AgentViewIntent {
  type: "navigate" | "focus_entity" | "open_panel" | "set_filter";
  route?: string;
  entityType?: "project" | "order" | "customer" | "invoice" | "ticket";
  entityId?: string;
  /** Optional initial Tab/section for the resolved entity (e.g. `relations`). */
  initialTab?: string;
  panel?: string;
  filters?: Record<string, string | number | boolean | null>;
  label: string;
  reason?: string;
}

export type AgentTimelineItem =
  | {
      id: string;
      kind: "text";
      content: string;
      status?: string;
      startedAt?: number;
      endedAt?: number;
    }
  | {
      id: string;
      kind: "thinking";
      content?: string;
      status: "running" | "done" | "error";
      startedAt?: number;
      endedAt?: number;
    }
  | {
      id: string;
      kind: "tool";
      toolName: string;
      label: string;
      content?: string;
      status: "running" | "done" | "error";
      input?: unknown;
      output?: unknown;
      error?: string;
      /**
       * P1-3 UI 接线：当工具失败为 NEEDS_USER_CONFIRMATION 时，runtime 经 NDJSON
       * tool_error 事件透传 code，前端据此渲染 needs-user-confirmation 卡片而非
       * 红色错误行。其余失败分支省略（保持原渲染）。
       */
      code?: string;
      /**
       * P1-3 UI 接线：需要用户确认的 confirm actionKey（= 模型调的 propose_*
       * 对应的 confirm action）。卡片据此 mint 匹配的 AgentUserConfirmationEvent。
       * 仅在 code === "NEEDS_USER_CONFIRMATION" 时有意义。
       */
      targetIntent?: string;
    }
  | {
      id: string;
      kind: "compact";
      content: string;
      status: "running" | "done" | "error";
      tokensBefore?: number;
      tokensAfter?: number;
    }
  | {
      id: string;
      kind: "memory";
      content: string;
      status: "suggested" | "saved" | "rejected";
      memoryId?: string;
    }
  | {
      id: string;
      kind: "view";
      intent: AgentViewIntent;
      status: "suggested" | "applied" | "rejected";
    }
  | {
      id: string;
      kind: "proactive";
      content: string;
      status: "suggested" | "scheduled" | "sent" | "rejected";
      taskId?: string;
    };

/** 用户消息携带的通用附件（读路径自 AgentChatAttachmentLink 展开；docs §3.3）。 */
export interface AgentChatMessageAttachment {
  stagingFileId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  status: string;
  /** staging 已过 TTL（内容端点将 410），前端按「附件已过期」降级展示。 */
  expired: boolean;
}

export interface AgentChatMessageRecord {
  id: string;
  sessionId: string;
  agentRunId?: string | null;
  userId: string;
  role: string;
  content: string;
  state: string;
  timeline: AgentTimelineItem[];
  tokenUsage?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  attachments?: AgentChatMessageAttachment[];
  createdAt: string;
}

export interface AgentChatSessionSummaryRecord {
  id: string;
  userId: string;
  agentRunId?: string | null;
  title?: string | null;
  status: string;
  source: string;
  summary?: string | null;
  compactSummary?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  messageCount: number;
}

export interface AgentChatSessionDetailRecord extends AgentChatSessionSummaryRecord {
  messages: AgentChatMessageRecord[];
}

export interface AgentMemoryRecord {
  id: string;
  userId: string;
  scope: string;
  kind: string;
  content: string;
  confidence: number;
  source: string;
  sourceMessageId?: string | null;
  status: string;
  metadata?: Record<string, unknown> | null;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProactiveTaskRecord {
  id: string;
  userId: string;
  agentRunId?: string | null;
  sessionId?: string | null;
  kind: string;
  title: string;
  payload: Record<string, unknown>;
  status: string;
  triggerAt: string;
  notificationId?: string | null;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string | null;
}

export interface AgentRuntimeToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  presentation?: {
    type: "card" | "none";
    narration: "minimal" | "normal";
  };
}

export interface AgentRuntimeMessageContext {
  verifiedCustomerProfileId?: string;
  /** @deprecated Prefer verifiedInvoiceStagingFiles. */
  verifiedInvoiceStaging?: {
    stagingFileId: string;
    sha256: string;
    version: number;
    fileName: string;
  };
  verifiedInvoiceStagingFiles?: Array<{
    stagingFileId: string;
    sha256: string;
    version: number;
    fileName: string;
  }>;
}
