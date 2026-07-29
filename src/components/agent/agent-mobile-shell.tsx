"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { ArrowDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { AgentChatMessageAttachment, AgentTimelineItem, AgentViewIntent } from "@/lib/agent-runtime/types";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Sidebar } from "@/components/sidebar";
import { useMobileNavStore } from "@/lib/stores/mobile-nav-store";
import { appendVerifiedCustomerHistoryContext } from "@/lib/agent-runtime/history-context";
import {
  resolveSendMessageWithInvoiceStaging,
  uploadAgentInvoiceStagingFiles,
  AGENT_INVOICE_STAGING_MAX_FILES,
  type AgentInvoiceStagingAttachment,
} from "@/lib/agent/invoice-staging-attachment";
import {
  applyInvoiceQueueFromProposals,
  applyInvoiceQueueStreamEvent,
  buildInvoiceQueueContinuation,
  getActiveInvoiceQueue,
  patchInvoiceQueueItem,
  restoreInvoiceQueueFromServer,
} from "@/lib/agent/invoice-staging-queue";
import {
  consumeAgentStream,
  isInvoiceAnalyzeFailureEvent,
  type ConsumeResult,
} from "@/lib/agent-stream/consume-agent-stream";
import {
  buildAgentAttachmentMessageContext,
  toOptimisticMessageAttachments,
  uploadAgentAttachments,
  type AgentGenericAttachment,
} from "@/lib/agent/agent-attachment-upload";
import { DEFAULT_ATTACHMENT_ONLY_MESSAGE } from "@/lib/agent-attachments/constants";
import {
  classifyChatStream409,
  removeOptimisticTurn,
  restoreGenericQueueAfterConflict,
  type PiStreamResult,
} from "@/lib/agent/chat-stream-result";
import { AgentMobileHeader, type AgentRuntimeStatus } from "./agent-mobile-header";
import { AgentSessionSheet, type AgentSessionSummary } from "./agent-session-sheet";
import { AgentMobileComposer } from "./agent-mobile-composer";
import { AgentResourceSheet } from "./resources/agent-resource-sheet";
import { useAgentResourceNavigation } from "./use-agent-resource-navigation";
import type { AgentChatMessage, AgentProposal } from "./chat-panel";
import { ensureCardsRegistered } from "./cards";
import {
  AgentChatEmptyState,
  AgentMessageRow,
  AgentProcessStatusRow,
  DateSeparator,
} from "./agent-message-feed";
import {
  appendAgentStreamEvent,
  createMessage,
  createStreamingAssistantMessage,
  finishRunningTimeline,
  isSameMessageDay,
  mapSessionMessage,
} from "./agent-message-helpers";
import { replaceProposalInMessages } from "./replace-proposal-in-messages";
import { useElementHeight } from "@/hooks/use-element-height";

// Register all GenUI cards on module load
ensureCardsRegistered();

// ---- Types mirroring agent-workbench.tsx (no second session model) ----

interface AgentChatSessionDetail extends AgentSessionSummary {
  messages: Array<{
    id: string;
    role: string;
    content: string;
    state: string;
    timeline: AgentTimelineItem[];
    createdAt: string;
    attachments?: AgentChatMessageAttachment[];
  }>;
}

// Module-scope counter: keeps manual timeline ids unique without calling
// Date.now/Math.random in component scope (react-hooks/purity).
let manualToolIdCounter = 0;
function nextManualToolId(actionKey: string) {
  manualToolIdCounter += 1;
  return `tool_${actionKey}_${manualToolIdCounter}`;
}

// ---- Main shell component ----

export function AgentMobileShell({ genuiEnabled, asrEnabled }: { genuiEnabled: boolean; asrEnabled: boolean }) {
  const router = useRouter();
  const { data: session, status } = useSession();
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [invoiceStagingAttachments, setInvoiceStagingAttachments] = useState<AgentInvoiceStagingAttachment[]>([]);
  const [invoiceStagingUploading, setInvoiceStagingUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [proposalBusyId, setProposalBusyId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sessionSheetOpen, setSessionSheetOpen] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<AgentRuntimeStatus>("available");
  const [showScrollFab, setShowScrollFab] = useState(false);
  const resourceNavigation = useAgentResourceNavigation();

  // Dirty card registry: tracks which cards in the current session have
  // unsaved local state (e.g. geo data, summary text).  Uses a Set<cardId>
  // so multiple cards don't clobber each other.  Used to prompt before
  // switching or creating sessions.
  const dirtyCardIdsRef = useRef<Set<string>>(new Set());

  function setCardDirty(cardId: string, dirty: boolean) {
    const current = dirtyCardIdsRef.current;
    if (dirty) {
      current.add(cardId);
    } else {
      current.delete(cardId);
    }
  }

  function hasDirtyCards() {
    return dirtyCardIdsRef.current.size > 0;
  }

  function clearDirtyCards() {
    dirtyCardIdsRef.current.clear();
  }

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const composerHeight = useElementHeight(composerRef, 112);
  const fadePx = Math.min(Math.max(composerHeight, 64), 120);
  // 浮件区顶部留白与渐隐高度（docs Part 2 §2.1）：
  // - topPaddingPx：内容顶部预留高度，避免首条消息被浮件（≈ h-9 + safe-area + 0.5rem 间距 ≈ 56px）遮挡；
  // - topFadePx：mask 顶部渐隐带高度（约 24-32px），让消息能半透明滑入浮件下方。
  const topPaddingPx = 64;
  const topFadePx = 28;
  const isAtBottomRef = useRef(true);
  // Aborts the in-flight stream fetch on session switch / unmount / new send,
  // so the reader doesn't keep draining a dead connection.
  const streamAbortRef = useRef<AbortController | null>(null);
  // 区分「用户主动停止」与「会话切换/重新发送触发的 abort」：前者在消息里
  // 留下「已停止」收尾，后者静默丢弃在途流。
  const userStoppedRef = useRef(false);

  function stopStreaming() {
    if (!busy) return;
    userStoppedRef.current = true;
    streamAbortRef.current?.abort();
  }
  // Session id adopted by the in-flight stream (server-created on first send).
  // The loadSessionDetail effect must not reload it mid-stream.
  const streamOwnedSessionRef = useRef<string | null>(null);
  // Mirror of invoiceStagingAttachments for reading the latest queue state
  // inside async callbacks (runPiStream / sendMessage) without stale closures.
  const invoiceStagingAttachmentsRef = useRef<AgentInvoiceStagingAttachment[]>([]);
  useEffect(() => {
    invoiceStagingAttachmentsRef.current = invoiceStagingAttachments;
  }, [invoiceStagingAttachments]);

  // ── 通用附件队列（移动端：选择/粘贴，浏览器允许时）──
  const [genericAttachments, setGenericAttachments] = useState<AgentGenericAttachment[]>([]);
  const [genericUploading, setGenericUploading] = useState(false);
  const genericAttachmentsRef = useRef<AgentGenericAttachment[]>([]);
  useEffect(() => {
    genericAttachmentsRef.current = genericAttachments;
  }, [genericAttachments]);

  async function handleAddGenericFiles(files: File[]) {
    if (files.length === 0) return;
    setGenericUploading(true);
    try {
      const { attachments, failures } = await uploadAgentAttachments(files, {
        agentRunId: agentRunId ?? null,
      });
      if (attachments.length > 0) setGenericAttachments((current) => [...current, ...attachments]);
      for (const failure of failures) {
        toast.error(`附件「${failure.fileName}」上传失败：${failure.error}`);
      }
    } finally {
      setGenericUploading(false);
    }
  }

  function handleRemoveGenericAttachment(stagingFileId: string) {
    setGenericAttachments((current) => current.filter((a) => a.stagingFileId !== stagingFileId));
    void fetch(`/api/agent/attachments/${stagingFileId}`, { method: "DELETE" }).catch(() => undefined);
  }
  // Set by runPiStream when the just-finished stream left a failed staging
  // item and the queue still has injectable files. Drained by the effect below
  // once busy flips to false, so the continuation re-enters sendMessage
  // cleanly instead of racing the previous send's busy guard.
  const pendingQueueAdvanceRef = useRef(false);
  // 409 治理（docs Part 1 §1.3）：A 类 409 把本页钉到 legacy 模式。
  const runtimeModeRef = useRef<"pi" | "legacy">("pi");
  // 首次 legacy 回退才 toast 一次（每页一次）。
  const legacyFallbackShownRef = useRef(false);

  useEffect(() => {
    return () => streamAbortRef.current?.abort();
  }, []);

  // Drain a pending queue advance once busy is released. runPiStream sets the
  // flag from the ref-backed latest queue state; this effect fires the single
  // continuation after busy flips false, avoiding re-entrant sends and keeping
  // setState updaters pure.
  useEffect(() => {
    if (busy || !pendingQueueAdvanceRef.current) return;
    pendingQueueAdvanceRef.current = false;
    const latest = invoiceStagingAttachmentsRef.current;
    if (getActiveInvoiceQueue(latest).length > 0) {
      void continueInvoiceQueue(latest);
    }
    // continueInvoiceQueue is intentionally read from the latest render
    // closure; depending on it would fire this effect every render and break
    // the busy-edge trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  // ── Android/browser back integration for the Resource Sheet ─────────────
  // While the full-screen resource sheet is open we keep a sentinel history
  // entry armed; a system back press pops it and we translate that into
  // resource-history back (or sheet close) instead of leaving /agent.
  const sheetMarkerArmedRef = useRef(false);
  const resourceNavigationRef = useRef(resourceNavigation);
  useEffect(() => {
    resourceNavigationRef.current = resourceNavigation;
  });

  // Arm the sentinel when the sheet opens.
  useEffect(() => {
    if (resourceNavigation.state.open && !sheetMarkerArmedRef.current) {
      window.history.pushState({ agentResourceSheet: true }, "");
      sheetMarkerArmedRef.current = true;
    }
  }, [resourceNavigation.state.open]);

  // Manual close via UI button: consume the armed sentinel so a later system
  // back doesn't land on a stale entry.
  const prevSheetOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = prevSheetOpenRef.current;
    prevSheetOpenRef.current = resourceNavigation.state.open;
    if (wasOpen && !resourceNavigation.state.open && sheetMarkerArmedRef.current) {
      sheetMarkerArmedRef.current = false;
      window.history.back();
    }
  }, [resourceNavigation.state.open]);

  useEffect(() => {
    function onPopState() {
      if (!sheetMarkerArmedRef.current) return;
      sheetMarkerArmedRef.current = false;
      const nav = resourceNavigationRef.current;
      if (!nav.state.open) return;
      const hadDeeperHistory = nav.canBack;
      nav.back();
      if (hadDeeperHistory) {
        // Sheet survives on an earlier resource — re-arm so the next system
        // back closes it instead of navigating away from /agent.
        window.history.pushState({ agentResourceSheet: true }, "");
        sheetMarkerArmedRef.current = true;
      }
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.replace("/login");
    }
  }, [router, status]);

  // Load sessions
  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    async function loadSessions() {
      try {
        const res = await fetch("/api/agent/chat-sessions");
        if (!res.ok) throw new Error("Failed to load sessions");
        const data = await res.json() as { sessions: AgentSessionSummary[] };
        if (cancelled) return;
        const nextSessions = Array.isArray(data.sessions) ? data.sessions : [];
        setSessions(nextSessions);
        setActiveSessionId((current) => {
          if (current && nextSessions.some((s) => s.id === current)) return current;
          return nextSessions[0]?.id ?? null;
        });
      } catch {
        if (!cancelled) toast.error("无法加载会话列表");
      } finally {
        if (!cancelled) setLoadingSessions(false);
      }
    }
    void loadSessions();
    return () => { cancelled = true; };
  }, [status]);

  // Load session detail
  useEffect(() => {
    if (status !== "authenticated" || !activeSessionId) return;
    // When runPiStream adopts a server-created session id mid-stream, this
    // effect would otherwise fire and replace the live streaming messages with
    // the (still user-message-only) server snapshot — wiping the placeholder
    // and silently dropping every subsequent stream event.  Skip that load;
    // runPiStream performs its own detail sync when the stream finishes.
    if (streamOwnedSessionRef.current === activeSessionId) {
      streamOwnedSessionRef.current = null;
      return;
    }
    let cancelled = false;
    async function loadSessionDetail() {
      setLoadingMessages(true);
      try {
        const res = await fetch(`/api/agent/chat-sessions/${activeSessionId}`);
        if (!res.ok) throw new Error("Failed to load session");
        const data = await res.json() as { session: AgentChatSessionDetail };
        if (!cancelled && data.session) {
          const runId = data.session.agentRunId ?? null;
          startTransition(() => {
            setAgentRunId(runId);
            setMessages(Array.isArray(data.session.messages) ? data.session.messages.map(mapSessionMessage) : []);
          });
          if (runId) {
            try {
              const stagingRes = await fetch(
                `/api/agent/invoice-staging?agentRunId=${encodeURIComponent(runId)}&status=UPLOADED,ANALYZING,ANALYZED`,
              );
              if (stagingRes.ok && !cancelled) {
                const stagingData = await stagingRes.json() as {
                  items?: Array<{
                    id: string;
                    fileName: string;
                    mimeType: string;
                    fileSize: number;
                    sha256: string;
                    version: number;
                    expiresAt: string;
                    status: string;
                    pendingProposalId?: string | null;
                  }>;
                };
                const restored = restoreInvoiceQueueFromServer(
                  Array.isArray(stagingData.items) ? stagingData.items : [],
                );
                if (!cancelled) setInvoiceStagingAttachments(restored);
              } else if (!cancelled && stagingRes.status === 403) {
                setInvoiceStagingAttachments([]);
              }
            } catch {
              // non-fatal
            }
          } else if (!cancelled) {
            setInvoiceStagingAttachments([]);
          }
        }
      } catch {
        if (!cancelled) toast.error("无法加载会话消息");
      } finally {
        if (!cancelled) setLoadingMessages(false);
      }
    }
    void loadSessionDetail();
    return () => { cancelled = true; };
  }, [activeSessionId, status]);

  const refreshSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/chat-sessions");
      if (!res.ok) throw new Error("Failed to load sessions");
      const data = await res.json() as { sessions: AgentSessionSummary[] };
      const nextSessions = Array.isArray(data.sessions) ? data.sessions : [];
      setSessions(nextSessions);
    } catch {
      // silent
    }
  }, []);

  // Auto-scroll to bottom when messages change, unless user scrolled up
  useEffect(() => {
    if (!scrollRef.current) return;
    if (isAtBottomRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, busy]);

  // Track scroll position
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    isAtBottomRef.current = atBottom;
    setShowScrollFab(!atBottom && messages.length > 0);
  }, [messages.length]);

  const scrollToBottom = useCallback(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    isAtBottomRef.current = true;
    setShowScrollFab(false);
  }, []);

  async function refreshProposals() {
    try {
      await fetch("/api/agent/proposals");
    } catch {
      // silent
    }
  }

  function findProposalStagingFileId(proposalId: string): string | null {
    for (const message of messages) {
      for (const proposal of message.proposals || []) {
        if (proposal.id !== proposalId) continue;
        const input = proposal.input;
        if (input && typeof input === "object" && !Array.isArray(input)) {
          const id = (input as Record<string, unknown>).stagingFileId;
          if (typeof id === "string" && id.trim()) return id.trim();
        }
      }
    }
    return null;
  }

  async function continueInvoiceQueue(nextAttachments: AgentInvoiceStagingAttachment[]) {
    const continuation = buildInvoiceQueueContinuation({ remaining: nextAttachments });
    if (!continuation || busy) return;
    await sendMessage(continuation.content, {
      attachments: getActiveInvoiceQueue(nextAttachments),
    });
  }

  async function confirmProposal(proposalId: string) {
    if (proposalBusyId) return;
    setProposalBusyId(proposalId);
    const stagingFileId = findProposalStagingFileId(proposalId);
    try {
      const res = await fetch(`/api/agent/proposals/${proposalId}/confirm`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "确认失败");
      toast.success("已执行");
      setMessages((current) => {
        const next = data.proposal
          ? replaceProposalInMessages(current, data.proposal as AgentProposal)
          : current;
        return [...next, createMessage("assistant", "已根据你的确认执行该动作。")];
      });
      await refreshProposals();
      if (stagingFileId) {
        const updated = patchInvoiceQueueItem(invoiceStagingAttachments, stagingFileId, {
          queueStatus: "registered",
        });
        setInvoiceStagingAttachments(updated);
        const remaining = getActiveInvoiceQueue(updated);
        if (remaining.length > 0) {
          void continueInvoiceQueue(remaining);
        }
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "确认失败");
      if (stagingFileId) {
        setInvoiceStagingAttachments((current) =>
          patchInvoiceQueueItem(current, stagingFileId, { queueStatus: "failed" }),
        );
      }
    } finally {
      setProposalBusyId(null);
    }
  }

  async function rejectProposal(proposalId: string) {
    if (proposalBusyId) return;
    setProposalBusyId(proposalId);
    const stagingFileId = findProposalStagingFileId(proposalId);
    try {
      const res = await fetch(`/api/agent/proposals/${proposalId}/reject`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "拒绝失败");
      toast.success("已取消");
      setMessages((current) => {
        const next = data.proposal
          ? replaceProposalInMessages(current, data.proposal as AgentProposal)
          : current;
        return [...next, createMessage("assistant", "这条操作已标记为暂不执行。")];
      });
      await refreshProposals();
      if (stagingFileId) {
        const updated = patchInvoiceQueueItem(invoiceStagingAttachments, stagingFileId, {
          queueStatus: "skipped",
        });
        setInvoiceStagingAttachments(updated);
        const remaining = getActiveInvoiceQueue(updated);
        if (remaining.length > 0) {
          void continueInvoiceQueue(remaining);
        }
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "拒绝失败");
    } finally {
      setProposalBusyId(null);
    }
  }

  async function updateProposal(proposalId: string, input: Record<string, unknown>) {
    const res = await fetch(`/api/agent/proposals/${proposalId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "更新失败");
    const proposal = data.proposal as AgentProposal;
    setMessages((current) => replaceProposalInMessages(current, proposal));
    return proposal;
  }

  async function createProposal(actionKey: string, input: Record<string, unknown>): Promise<AgentProposal | null> {
    try {
      // Use tools/execute which creates a PENDING proposal for confirm actions,
      // or returns a result for safe actions.
      const res = await fetch("/api/agent/tools/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionKey, agentRunId, input }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "创建失败");
      if (data.mode === "proposal" && data.proposal) {
        const proposal = data.proposal as AgentProposal;
        // Add the proposal as a new assistant message so it appears in the timeline
        setMessages((current) => [
          ...current,
          createMessage("assistant", "", { proposals: [proposal] }),
        ]);
        return proposal;
      }
      if (data.mode === "result" && data.result) {
        // Safe action returned a result - add it as a tool timeline item in a
        // new assistant message so the GenUI card renders.
        const toolId = nextManualToolId(actionKey);
        setMessages((current) => [
          ...current,
          createMessage("assistant", "", {
            timeline: [{
              id: toolId,
              kind: "tool" as const,
              toolName: actionKey,
              label: actionKey,
              status: "done" as const,
              input,
              output: data.result,
            }],
          }),
        ]);
        return null;
      }
      return null;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建操作失败");
      return null;
    }
  }

  async function applyViewIntent(intent: AgentViewIntent) {
    // focus_entity / open_panel with entity: open in the workspace Resource
    // Sheet instead of navigating away from the Agent.
    if (
      (intent.type === "focus_entity" || intent.type === "open_panel") &&
      intent.entityType &&
      intent.entityId
    ) {
      resourceNavigation.openResource({
        type: "entity",
        entityType: intent.entityType,
        entityId: intent.entityId,
        label: intent.label,
      });
      return;
    }

    try {
      const res = await fetch("/api/agent/view-intents/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "视图切换失败");
      if (data.applied?.mode === "navigate" && typeof data.applied.route === "string") {
        const url = new URL(data.applied.route, window.location.origin);
        if (data.applied.searchParams && typeof data.applied.searchParams === "object") {
          for (const [key, value] of Object.entries(data.applied.searchParams as Record<string, unknown>)) {
            if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
          }
        }
        router.push(`${url.pathname}${url.search}`);
        return;
      }
      toast.message(typeof data.applied?.label === "string" ? data.applied.label : "视图建议已应用");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "视图切换失败");
    }
  }

  async function runPiStream(content: string, assistantId: string, metadata?: { inputMode?: "voice" | "text"; messageContext?: Record<string, unknown>; signal?: AbortSignal }): Promise<PiStreamResult> {
    setRuntimeStatus("available");
    const res = await fetch("/api/agent/chat-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: activeSessionId,
        agentRunId,
        message: content,
        // 仅当语音输入时带上 inputMode，普通文本输入不带（后端按 undefined 处理）。
        ...(metadata?.inputMode ? { inputMode: metadata.inputMode } : {}),
        ...(metadata?.messageContext ? { messageContext: metadata.messageContext } : {}),
      }),
      signal: metadata?.signal,
    });

    if (res.status === 409) {
      // 只解析、不回滚：sendMessage 持有本轮快照，统一执行回滚。
      const data = await res.json().catch(() => ({}));
      const code = typeof data.code === "string" ? data.code : undefined;
      const message = typeof data.error === "string" ? data.error : "Agent stream failed";
      if (classifyChatStream409(code) === "runtime_not_pi") {
        // A 类：runtime 故障 → degraded。
        setRuntimeStatus("degraded");
        return { kind: "runtime_unavailable" };
      }
      // B/C/未知：附件冲突，不是 runtime 故障 → 恢复 available。
      setRuntimeStatus("available");
      return { kind: "conflict", code, message };
    }
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      setRuntimeStatus("unavailable");
      throw new Error(typeof data.error === "string" ? data.error : "Agent stream failed");
    }

    const nextSessionId = res.headers.get("x-agent-session-id");
    const nextRunId = res.headers.get("x-agent-run-id");
    if (nextSessionId) {
      // Mark stream-owned adoption so the loadSessionDetail effect skips it.
      if (nextSessionId !== activeSessionId) streamOwnedSessionRef.current = nextSessionId;
      setActiveSessionId(nextSessionId);
    }
    if (nextRunId) setAgentRunId(nextRunId);

    // Canonical SSE consumption via the shared consumer (design §9.1 / plan §6.8).
    // Local, per-turn flag: only set when this stream actually emitted an
    // invoice staging tool_execution.failed. Gates queue advance so historical
    // "failed" items do NOT re-trigger advance on later unrelated turns.
    let sawInvoiceToolErrorThisTurn = false;

    const consumeResult: ConsumeResult = await consumeAgentStream(res, {
      signal: metadata?.signal,
      onEvent(event) {
        setMessages((current) => appendAgentStreamEvent(current, assistantId, event));
        setInvoiceStagingAttachments((current) => applyInvoiceQueueStreamEvent(current, event));
        if (isInvoiceAnalyzeFailureEvent(event)) sawInvoiceToolErrorThisTurn = true;
      },
      onCompleted() {
        // success terminal — reducer already flipped state=done.
      },
      onFailed() {
        // failure terminal — reducer already marked state=error.
      },
      onDisconnectedBeforeTerminal() {
        // EOF without terminal: do NOT mark done. Session-detail reload below
        // recalibrates against the server snapshot.
      },
    });
    if (consumeResult.terminal === "aborted") {
      throw new DOMException("The user aborted a request.", "AbortError");
    }

    await refreshSessions();
    if (nextSessionId) {
      const detailRes = await fetch(`/api/agent/chat-sessions/${nextSessionId}`);
      if (detailRes.ok) {
        const data = await detailRes.json() as { session: AgentChatSessionDetail };
        const mapped = Array.isArray(data.session.messages)
          ? data.session.messages.map(mapSessionMessage)
          : [];
        // Preserve messages appended locally after streaming finished (e.g. a
        // proposal confirm/reject note) — the server snapshot doesn't include
        // them and a blind replace would drop them.
        setMessages((current) => {
          const anchor = current.findIndex((message) => message.id === assistantId);
          const tail = anchor >= 0
            ? current.slice(anchor + 1).filter((message) => !mapped.some((item: AgentChatMessage) => item.id === message.id))
            : [];
          return [...mapped, ...tail];
        });
        setAgentRunId(data.session.agentRunId ?? nextRunId ?? null);
        const proposals = mapped.flatMap((message) => message.proposals || []);
        if (proposals.length > 0) {
          setInvoiceStagingAttachments((current) =>
            applyInvoiceQueueFromProposals(current, proposals),
          );
        }
      }
    }
    // Gate queue advance on the per-turn tool_error flag (not historical
    // "failed" items, which persist and would re-trigger advance on every
    // subsequent unrelated turn). Still require injectable items to remain.
    const latestAttachments = invoiceStagingAttachmentsRef.current;
    const shouldAdvanceQueue =
      sawInvoiceToolErrorThisTurn
      && getActiveInvoiceQueue(latestAttachments).length > 0;
    return { kind: "streamed", shouldAdvanceQueue };
  }

  async function runLegacyChat(content: string, metadata?: { inputMode?: "voice" | "text"; messageContext?: Record<string, unknown> }) {
    const res = await fetch("/api/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentRunId,
        message: content,
        history: messages.map((m) => ({
          role: m.role,
          content: m.role === "assistant"
            ? appendVerifiedCustomerHistoryContext(m.content, m.timeline)
            : m.content,
        })),
        // 降级到 legacy planner 时仍透传 inputMode，否则语音输入会退化成普通
        // 文本查询，丢失同音错字解析（crm.resolve_customer_name）触发机会。
        ...(metadata?.inputMode ? { inputMode: metadata.inputMode } : {}),
        ...(metadata?.messageContext ? { messageContext: metadata.messageContext } : {}),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Agent chat failed");

    if (typeof data.agentRunId === "string" && data.agentRunId) {
      setAgentRunId((current) => current ?? data.agentRunId);
    }
    setMessages((current) => [
      ...current,
      createMessage("assistant", data.reply, {
        toolRuns: Array.isArray(data.toolRuns) ? data.toolRuns : [],
        followUps: Array.isArray(data.followUps) ? data.followUps : [],
        proposals: Array.isArray(data.proposals) ? data.proposals : [],
      }),
    ]);
    if (Array.isArray(data.proposals) && data.proposals.length > 0) {
      setInvoiceStagingAttachments((current) =>
        applyInvoiceQueueFromProposals(current, data.proposals as Array<{
          actionKey?: string;
          status?: string;
          input?: unknown;
        }>),
      );
    }
  }

  async function sendMessage(
    nextMessage?: string,
    metadata?: {
      inputMode?: "voice" | "text";
      messageContext?: Record<string, unknown>;
      attachments?: AgentInvoiceStagingAttachment[];
    },
  ) {
    const pendingAttachments = metadata?.attachments
      ?? (nextMessage == null ? getActiveInvoiceQueue(invoiceStagingAttachments) : []);
    // 附件快照统一从 ref 派生（禁 state 闭包），避免 409 回滚时丢失刚上传
    // 完成的附件（docs Part 1 §1.3 R3）。
    const previousGenericQueue = [...genericAttachmentsRef.current];
    const pendingGeneric = previousGenericQueue.filter((a) => a.stagingFileId && !a.uploadError);
    // 已知 legacy 模式硬门禁：legacy /api/agent/chat 不支持通用附件，本轮带有效
    // 通用附件 → 在追加乐观消息之前直接拒绝，零网络往返；保留草稿与附件队列。
    if (runtimeModeRef.current === "legacy" && pendingGeneric.length > 0) {
      toast.error("兼容模式暂不支持通用附件，请移除附件后重试");
      return;
    }
    const resolved = resolveSendMessageWithInvoiceStaging({
      draft: nextMessage ?? draft,
      attachments: pendingAttachments,
      includeAttachments: true,
    });
    // loadingMessages: sending while the session detail is still loading would
    // let the in-flight load overwrite the freshly appended messages.
    if (busy || loadingMessages) return;
    if (!resolved && pendingGeneric.length === 0) return;
    let content = resolved?.content ?? "";
    if (!content && pendingGeneric.length > 0) content = DEFAULT_ATTACHMENT_ONLY_MESSAGE;
    if (!content) return;
    const messageContext = {
      ...(metadata?.messageContext || {}),
      ...(resolved?.messageContext || {}),
      ...(pendingGeneric.length > 0 ? buildAgentAttachmentMessageContext(pendingGeneric) : {}),
    };
    const hasMessageContext = Object.keys(messageContext).length > 0;

    streamAbortRef.current?.abort();
    userStoppedRef.current = false;
    const streamController = new AbortController();
    streamAbortRef.current = streamController;
    const userMessage = createMessage("user", content, {
      // 乐观显示附件文件卡片；流结束后会被服务端快照（含 AgentChatAttachmentLink 数据）替换。
      attachments: pendingGeneric.length > 0 ? toOptimisticMessageAttachments(pendingGeneric) : undefined,
    });
    const assistantMessage = createStreamingAssistantMessage();
    const previousDraft = draft;
    setDraft("");
    // 通用附件随本条消息发出后清空队列。
    if (pendingGeneric.length > 0) setGenericAttachments([]);
    // 保留队列；由 tool/proposal 事件更新进度。
    setBusy(true);
    isAtBottomRef.current = true;
    setMessages((current) => [...current, userMessage, assistantMessage]);

    // B/C/未知 409 与 runtime_unavailable+通用附件 共用的回滚：算法调共享纯函数，
    // setState 在此执行。发票队列不做连带标记。
    const rollbackAttachmentConflict = () => {
      setMessages((current) => removeOptimisticTurn(current, userMessage.id, assistantMessage.id));
      setDraft(previousDraft);
      setGenericAttachments(
        restoreGenericQueueAfterConflict(
          previousGenericQueue,
          new Set(pendingGeneric.map((a) => a.stagingFileId)),
          "已失效，请重新添加",
        ),
      );
      pendingQueueAdvanceRef.current = false;
    };

    const nextMetadata = {
      ...metadata,
      ...(hasMessageContext ? { messageContext } : {}),
      signal: streamController.signal,
    };

    try {
      // 已知 legacy 模式：跳过 chat-stream，直走 legacy（每页一次判定后零 RTT）。
      // 通用附件门禁已在上方拦截；这里只可能是纯文本 / 发票 staging 消息。
      if (runtimeModeRef.current === "legacy") {
        setRuntimeStatus("degraded");
        setMessages((current) => current.filter((m) => m.id !== assistantMessage.id));
        await runLegacyChat(content, nextMetadata);
        return;
      }
      const result = await runPiStream(content, assistantMessage.id, nextMetadata);
      if (result.kind === "streamed") {
        // Arm the queue advance; the busy-release effect will fire it exactly
        // once, after this send fully unwinds and busy flips to false.
        if (result.shouldAdvanceQueue) {
          pendingQueueAdvanceRef.current = true;
        }
      } else if (result.kind === "runtime_unavailable") {
        // A 类 409：runtime 未配置。通用附件硬门禁——legacy route 不支持
        // verifiedAgentAttachments，禁回退，走与 conflict 相同的回滚。
        if (pendingGeneric.length > 0) {
          runtimeModeRef.current = "legacy";
          setRuntimeStatus("degraded");
          rollbackAttachmentConflict();
          toast.error("兼容模式暂不支持通用附件，请移除附件后重试");
          return;
        }
        // 钉到 legacy：后续消息直走 runLegacyChat，不再打 chat-stream。
        runtimeModeRef.current = "legacy";
        setRuntimeStatus("degraded");
        if (!legacyFallbackShownRef.current) {
          legacyFallbackShownRef.current = true;
          toast.message("Agent 运行时为兼容模式，本次对话为非流式");
        }
        setMessages((current) => current.filter((m) => m.id !== assistantMessage.id));
        await runLegacyChat(content, nextMetadata);
      } else {
        // B/C/未知 409：conflict，fail-closed 不回退。
        rollbackAttachmentConflict();
        toast.error(result.message || "附件已失效，请重新上传后再发送");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        if (userStoppedRef.current) {
          // 用户主动停止：收尾时间线并提示；不回填草稿（消息已发出）。
          setMessages((current) => finishRunningTimeline(current, assistantMessage.id, {
            state: "done",
            content: "已停止本次生成。",
          }));
        } else {
          setDraft(previousDraft);
        }
        return;
      }
      setDraft(previousDraft);
      setMessages((current) => finishRunningTimeline(current, assistantMessage.id, {
        state: "error",
        content: "这次没有成功返回结果。你可以稍后重试，或者换一种问法。",
      }));
      toast.error(error instanceof Error ? error.message : "Agent chat failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleInvoiceStagingSelected(files: FileList | File[]) {
    const list = Array.from(files).slice(0, AGENT_INVOICE_STAGING_MAX_FILES);
    if (list.length === 0) return;
    setInvoiceStagingUploading(true);
    try {
      const { attachments, failures } = await uploadAgentInvoiceStagingFiles(list, {
        agentRunId,
      });
      if (attachments.length > 0) {
        setInvoiceStagingAttachments((current) => {
          const merged = [...current, ...attachments];
          return merged.slice(0, AGENT_INVOICE_STAGING_MAX_FILES);
        });
        toast.success(
          attachments.length === 1
            ? `已上传发票：${attachments[0].fileName}`
            : `已上传 ${attachments.length} 张发票`,
        );
      }
      if (failures.length > 0) {
        toast.error(
          failures.length === 1
            ? `${failures[0].fileName}：${failures[0].error}`
            : `${failures.length} 个文件上传失败`,
        );
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "发票上传失败");
    } finally {
      setInvoiceStagingUploading(false);
    }
  }

  function startNewConversation() {
    if (busy || proposalBusyId) return;
    if (hasDirtyCards()) {
      const ok = window.confirm("当前有未保存的卡片内容，切换会话将丢失。是否继续？");
      if (!ok) return;
    }
    clearDirtyCards();
    streamAbortRef.current?.abort();
    setActiveSessionId(null);
    setAgentRunId(null);
    setMessages([]);
    setDraft("");
    setInvoiceStagingAttachments([]);
    setSessionSheetOpen(false);
  }

  function handleSelectSession(sessionId: string) {
    if (sessionId === activeSessionId) {
      setSessionSheetOpen(false);
      return;
    }
    // Guard like startNewConversation: switching sessions mid-stream (or while
    // a proposal is executing) would corrupt the in-flight message state.
    if (busy || proposalBusyId) return;
    streamAbortRef.current?.abort();
    if (hasDirtyCards()) {
      const ok = window.confirm("当前有未保存的卡片内容，切换会话将丢失。是否继续？");
      if (!ok) return;
    }
    clearDirtyCards();
    setActiveSessionId(sessionId);
    setSessionSheetOpen(false);
  }

  async function handleDeleteSession(sessionId: string) {
    // 生成中不允许删除当前会话（流还在写它）；删其他会话不受影响。
    if (busy && sessionId === activeSessionId) return;
    const target = sessions.find((s) => s.id === sessionId);
    const ok = window.confirm(`删除会话「${target?.title?.trim() || "未命名会话"}」？会话内消息将一并删除。`);
    if (!ok) return;
    try {
      const res = await fetch(`/api/agent/chat-sessions/${sessionId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("删除失败");
      if (sessionId === activeSessionId) {
        startNewConversation();
      }
      await refreshSessions();
      toast.success("会话已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除会话失败");
    }
  }

  async function handleVoiceTranscribe(blob: Blob): Promise<string> {
    const formData = new FormData();
    const ext = blob.type.includes("webm") ? "webm" : blob.type.includes("mp4") ? "m4a" : "wav";
    formData.append("file", blob, `voice.${ext}`);
    const res = await fetch("/api/agent/asr-draft", { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "语音识别失败");
    return data.transcript || "";
  }

  const suggestions = useMemo(() => [
    "查最近活跃的 CRM 客户",
    "找一下周周",
    "哪些客户今天需要跟进？",
    "帮张三现场签到",
  ], []);

  if (status === "loading" || !session) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    // 高度链自给自足：不依赖父级 100dvh 容器。h-screen(100vh) 作兜底，
    // 支持 dvh 的浏览器用动态视口高（防 iOS 地址栏伸缩时输入条被顶出屏外）。
    <div className="flex h-screen supports-[height:100dvh]:h-[100dvh] min-h-0 flex-col bg-muted/40">
      {/* 消息流 + 悬浮顶栏 + 悬浮输入卡：顶栏与输入卡都浮在消息流之上（docs Part 2 §2.1） */}
      <div className="relative min-h-0 flex-1">
      {/* 浮动顶栏（absolute overlay，自带 safe-area paddingTop） */}
      <AgentMobileHeader
        runtimeStatus={runtimeStatus}
        onOpenSessions={() => setSessionSheetOpen(true)}
        onNewSession={startNewConversation}
        busy={busy || proposalBusyId != null}
      />

      {/* Message stream（上下双向渐隐 mask：顶部为浮件让位，底部为输入卡让位；顶部预留 paddingTop 防首条消息被浮件遮挡） */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto overscroll-contain"
        style={{
          maskImage: `linear-gradient(to bottom, transparent 0px, black ${topFadePx}px, black calc(100% - ${fadePx}px), transparent 100%)`,
          WebkitMaskImage: `linear-gradient(to bottom, transparent 0px, black ${topFadePx}px, black calc(100% - ${fadePx}px), transparent 100%)`,
        }}
      >
        <div
          className="mx-auto flex w-full max-w-2xl flex-col px-3 py-4"
          // composerHeight 只抵消输入卡高度；额外 +24px 让最后一条消息与输入卡之间有呼吸空间。
          style={{ paddingTop: topPaddingPx, paddingBottom: composerHeight + 24 }}
        >
          {messages.length === 0 && !loadingMessages ? (
            <AgentChatEmptyState suggestions={suggestions} onSuggestion={(s) => void sendMessage(s)} />
          ) : null}

          {loadingMessages && messages.length === 0 ? (
            <div className="flex items-center gap-2 py-8 justify-center text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              加载会话消息
            </div>
          ) : null}

          {messages.map((message, index) => {
            const showDate = index === 0 || !isSameMessageDay(messages[index - 1].createdAt, message.createdAt);
            return (
              <div key={message.id}>
                {showDate ? <DateSeparator dateStr={message.createdAt} /> : null}
                <AgentMessageRow
                  message={message}
                  userName={session.user.name}
                  proposalBusyId={proposalBusyId}
                  surface="mobile"
                  genuiEnabled={genuiEnabled}
                  actions={{
                    onConfirmProposal: confirmProposal,
                    onRejectProposal: rejectProposal,
                    onUpdateProposal: updateProposal,
                    onApplyViewIntent: applyViewIntent,
                    onOpenResource: (request, options) =>
                      void resourceNavigation.openResource(request, options?.target),
                    onCreateProposal: createProposal,
                    onSendPrefilled: (v, context) => void sendMessage(v, { messageContext: context }),
                    onCardDirtyChange: setCardDirty,
                    onUseFollowUp: (v) => void sendMessage(v),
                    // P1-3 UI 接线：needs-user-confirmation 卡片据此 mint AgentUserConfirmationEvent。
                    agentRunId: agentRunId ?? null,
                  }}
                />
              </div>
            );
          })}

          {/* Fallback process row only when stream placeholder has not been created yet */}
          {busy && !messages.some((m) => m.role === "assistant" && m.state === "streaming") ? (
            <div className="py-2">
              <AgentProcessStatusRow
                icon={<Loader2 className="h-3.5 w-3.5 animate-spin" />}
                label="正在思考"
                active
              />
            </div>
          ) : null}
        </div>
      </div>

        {/* Scroll to bottom FAB：悬浮于输入卡上方 */}
        {showScrollFab ? (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute left-1/2 z-20 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-border/60 bg-background shadow-md transition-colors hover:bg-muted"
            style={{ bottom: composerHeight + 8 }}
            aria-label="回到最新"
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        ) : null}

        {/* Bottom composer（悬浮，绝对定位于消息流之上） */}
        <AgentMobileComposer
        ref={composerRef}
        draft={draft}
        onDraftChange={setDraft}
        onSend={() => void sendMessage()}
        onStop={busy ? stopStreaming : undefined}
        busy={busy}
        asrEnabled={asrEnabled}
        onVoiceTranscribe={handleVoiceTranscribe}
        // GPT-style: stop recording → ASR → auto send, no draft review step.
        onVoiceSend={(transcript) => void sendMessage(transcript, { inputMode: "voice" })}
        invoiceStagingEnabled={session.user.role === "ADMIN"}
        invoiceStagingAttachments={invoiceStagingAttachments}
        invoiceStagingUploading={invoiceStagingUploading}
        onInvoiceStagingSelected={(files) => void handleInvoiceStagingSelected(files)}
        onInvoiceStagingClear={() => setInvoiceStagingAttachments([])}
        onInvoiceStagingRemove={(id) =>
          setInvoiceStagingAttachments((current) => current.filter((a) => a.stagingFileId !== id))
        }
        genericAttachments={genericAttachments}
        genericUploading={genericUploading}
        onGenericFilesSelected={(files) => void handleAddGenericFiles(files)}
        onGenericAttachmentRemove={handleRemoveGenericAttachment}
        />
      </div>

      <AgentSessionSheet
        open={sessionSheetOpen}
        onOpenChange={setSessionSheetOpen}
        sessions={sessions}
        activeSessionId={activeSessionId}
        loading={loadingSessions}
        onSelect={handleSelectSession}
        onNewSession={startNewConversation}
        onDelete={(id) => void handleDeleteSession(id)}
      />

      {/* Resource Sheet: full-screen overlay for in-chat resource links.
          Chat stays mounted underneath so scroll position / draft / session
          state survive a close. */}
      <AgentResourceSheet navigation={resourceNavigation} />

      {/* Navigation drawer (Agent page hides global Header, so we mount our own) */}
      <NavigationDrawer />
    </div>
  );
}

function NavigationDrawer() {
  const { drawerOpen, setDrawerOpen } = useMobileNavStore();
  return (
    <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
      <SheetContent
        side="left"
        className="w-64 border-r border-border bg-background p-0 shadow-none ring-0 data-[side=left]:rounded-r-none"
      >
        <Sidebar mobile onNavClick={() => setDrawerOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
