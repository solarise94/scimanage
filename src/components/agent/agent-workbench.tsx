"use client";

import { startTransition, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { AgentChatMessageAttachment, AgentTimelineItem, AgentViewIntent } from "@/lib/agent-runtime/types";
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
import type { AgentRuntimeStatus } from "@/lib/agent/runtime-status";
import { AgentChatPanel, type AgentChatMessage, type AgentProposal } from "./chat-panel";
import { AgentResourcePanel } from "./resources/agent-resource-panel";
import { useAgentResourceNavigation } from "./use-agent-resource-navigation";
import type { AgentSessionSummary } from "./agent-session-sheet";
import {
  appendAgentStreamEvent,
  createMessage,
  createStreamingAssistantMessage,
  finishRunningTimeline,
  mapSessionMessage,
} from "./agent-message-helpers";
import { replaceProposalInMessages } from "./replace-proposal-in-messages";
import type { AgentMessageActions } from "./agent-message-feed";

interface AgentChatSessionDetail extends AgentSessionSummary {
  agentRunId?: string | null;
  source?: string;
  compactSummary?: string | null;
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

export function AgentWorkbench({
  genuiEnabled = true,
  asrEnabled = false,
}: {
  genuiEnabled?: boolean;
  asrEnabled?: boolean;
}) {
  const router = useRouter();
  const { data: session, status } = useSession();
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposalBusyId, setProposalBusyId] = useState<string | null>(null);
  const [compactBusy, setCompactBusy] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [resourceCollapsed, setResourceCollapsed] = useState(false);
  const [invoiceStagingAttachments, setInvoiceStagingAttachments] = useState<AgentInvoiceStagingAttachment[]>([]);
  const [invoiceStagingUploading, setInvoiceStagingUploading] = useState(false);
  const resourceNavigation = useAgentResourceNavigation();
  const requestTokenRef = useRef(0);
  // Mirror of invoiceStagingAttachments for reading the latest queue state
  // inside async callbacks (runPiStream / sendMessage) without stale closures.
  const invoiceStagingAttachmentsRef = useRef<AgentInvoiceStagingAttachment[]>([]);
  useEffect(() => {
    invoiceStagingAttachmentsRef.current = invoiceStagingAttachments;
  }, [invoiceStagingAttachments]);

  // ── 通用附件队列（docs §3.1）：选择/拖放/粘贴共用同一上传与状态 ──
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
      if (attachments.length > 0) {
        setGenericAttachments((current) => [...current, ...attachments]);
      }
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
  // Aborts the in-flight stream fetch on session switch / unmount / new send,
  // so the reader doesn't keep draining a dead connection.
  const streamAbortRef = useRef<AbortController | null>(null);
  // 区分「用户主动停止」与「会话切换/重新发送触发的 abort」：前者要在消息里
  // 留下「已停止」收尾，后者保持原样（静默丢弃在途流）。
  const userStoppedRef = useRef(false);

  function stopStreaming() {
    if (!busy) return;
    userStoppedRef.current = true;
    streamAbortRef.current?.abort();
  }
  // Session id adopted by the in-flight stream (server-created on first send).
  // The loadSessionDetail effect must not reload it mid-stream.
  const streamOwnedSessionRef = useRef<string | null>(null);
  // Set by runPiStream when the just-finished stream left a failed staging
  // item and the queue still has injectable files. Drained by the effect below
  // once busy flips to false, so the continuation re-enters sendMessage
  // cleanly instead of racing the previous send's busy guard.
  const pendingQueueAdvanceRef = useRef(false);
  // 409 治理（docs Part 1 §1.3）：A 类 409 把本页钉到 legacy 模式，后续消息
  // 直走 runLegacyChat，不再每条都打一次 chat-stream 409 往返。
  const runtimeModeRef = useRef<"pi" | "legacy">("pi");
  // 桌面顶栏运行时状态点（与移动端同款三态）。
  const [runtimeStatus, setRuntimeStatus] = useState<AgentRuntimeStatus>("available");
  // 首次 legacy 回退才 toast 一次（每页一次）。
  const legacyFallbackShownRef = useRef(false);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
    }
  }, [router, status]);

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

  async function refreshSessions() {
    setSessionsLoading(true);
    try {
      const res = await fetch("/api/agent/chat-sessions");
      if (!res.ok) throw new Error("Failed to load chat sessions");
      const data = await res.json() as { sessions: AgentSessionSummary[] };
      const nextSessions = Array.isArray(data.sessions) ? data.sessions : [];
      setSessions(nextSessions);
      setActiveSessionId((current) => {
        if (current && nextSessions.some((item) => item.id === current)) return current;
        return current;
      });
    } catch {
      // Non-fatal: session switcher can retry on open
    } finally {
      setSessionsLoading(false);
    }
  }

  useEffect(() => {
    if (status !== "authenticated") return;
    // Defer to a microtask: refreshSessions sets loading state, and a
    // synchronous setState in an effect trips react-hooks/set-state-in-effect.
    void Promise.resolve().then(() => refreshSessions());
  }, [status]);

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
        if (!res.ok) throw new Error("Failed to load chat session");
        const data = await res.json() as { session: AgentChatSessionDetail };
        if (!cancelled && data.session) {
          const mapped = Array.isArray(data.session.messages)
            ? data.session.messages.map(mapSessionMessage)
            : [];
          const runId = data.session.agentRunId ?? null;
          startTransition(() => {
            setAgentRunId(runId);
            setMessages(mapped);
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
              // Non-fatal: queue restore can retry on next session load
            }
          } else if (!cancelled) {
            setInvoiceStagingAttachments([]);
          }
        }
      } catch (error) {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : "无法加载会话消息");
        }
      } finally {
        if (!cancelled) {
          setLoadingMessages(false);
        }
      }
    }

    void loadSessionDetail();
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, status]);

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
      setMessages((current) => [
        ...current,
        createMessage("assistant", "已根据你的确认执行该动作。"),
      ]);
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
      toast.success("已拒绝");
      setMessages((current) => [
        ...current,
        createMessage("assistant", "这条 proposal 已标记为暂不执行。"),
      ]);
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
      const res = await fetch("/api/agent/tools/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionKey, agentRunId, input }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "创建失败");
      if (data.mode === "proposal" && data.proposal) {
        const proposal = data.proposal as AgentProposal;
        setMessages((current) => [
          ...current,
          createMessage("assistant", "已生成待确认操作，请在下方确认。", { proposals: [proposal] }),
        ]);
        return proposal;
      }
      return null;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建失败");
      return null;
    }
  }

  async function runPiStream(
    content: string,
    userMessage: AgentChatMessage,
    assistantId: string,
    requestToken: number,
    signal: AbortSignal,
    messageContext?: Record<string, unknown>,
  ): Promise<PiStreamResult> {
    // 进入流式路径即视作 runtime 可用（conflict / unavailable 分支会另行覆盖）。
    setRuntimeStatus("available");
    const res = await fetch("/api/agent/chat-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: activeSessionId,
        agentRunId,
        message: content,
        ...(messageContext ? { messageContext } : {}),
      }),
      signal,
    });

    if (res.status === 409) {
      // 只解析、不回滚：sendMessage 持有本轮快照，统一执行回滚。
      const data = await res.json().catch(() => ({}));
      const code = typeof data.code === "string" ? data.code : undefined;
      const message = typeof data.error === "string" ? data.error : "Agent stream failed";
      if (classifyChatStream409(code) === "runtime_not_pi") {
        return { kind: "runtime_unavailable" };
      }
      return { kind: "conflict", code, message };
    }
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      setRuntimeStatus("unavailable");
      throw new Error(typeof data.error === "string" ? data.error : "Agent stream failed");
    }

    const nextSessionId = res.headers.get("x-agent-session-id");
    const nextRunId = res.headers.get("x-agent-run-id");
    if (requestToken === requestTokenRef.current) {
      if (nextSessionId) {
        // Mark stream-owned adoption so the loadSessionDetail effect skips it.
        if (nextSessionId !== activeSessionId) streamOwnedSessionRef.current = nextSessionId;
        setActiveSessionId(nextSessionId);
      }
      if (nextRunId) setAgentRunId(nextRunId);
    }

    // Canonical SSE consumption via the shared consumer. No local
    // buffer/split/JSON.parse — terminal state, dedup, abort, malformed are all
    // owned by consumeAgentStream (design §9.1 / plan §6.3).
    // Local, per-turn flag: only set when this stream actually emitted an
    // invoice staging tool_execution.failed. Gates queue advance so historical
    // "failed" items do NOT re-trigger advance on later unrelated turns.
    let sawInvoiceToolErrorThisTurn = false;

    const consumeResult: ConsumeResult = await consumeAgentStream(res, {
      signal,
      onEvent(event) {
        if (requestToken !== requestTokenRef.current) return;
        setMessages((current) => appendAgentStreamEvent(current, assistantId, event));
        setInvoiceStagingAttachments((current) => applyInvoiceQueueStreamEvent(current, event));
        if (isInvoiceAnalyzeFailureEvent(event)) sawInvoiceToolErrorThisTurn = true;
      },
      onCompleted() {
        // success terminal — message state already flipped by reducer.
      },
      onFailed() {
        // failure terminal — reducer already marked state=error.
      },
      onDisconnectedBeforeTerminal() {
        // EOF without completed/failed: do NOT mark done. Trigger session reload
        // to recalibrate against the server snapshot (which persists completed
        // turns). The session-detail reload below handles the recalibration.
      },
    });
    // If the stream was aborted (user stop / unmount / session switch), the
    // consumer returns "aborted" without surfacing a failure terminal. Caller's
    // AbortError branch in sendMessage handles the "已停止" tail.
    if (consumeResult.terminal === "aborted") {
      throw new DOMException("The user aborted a request.", "AbortError");
    }

    await refreshSessions();
    if (nextSessionId && requestToken === requestTokenRef.current) {
      const detailRes = await fetch(`/api/agent/chat-sessions/${nextSessionId}`);
      if (detailRes.ok && requestToken === requestTokenRef.current) {
        const data = await detailRes.json() as { session: AgentChatSessionDetail };
        const mapped = Array.isArray(data.session.messages)
          ? data.session.messages.map(mapSessionMessage)
          : [userMessage];
        // Preserve messages appended locally after streaming finished (e.g. a
        // proposal confirm/reject note) — the server snapshot doesn't include
        // them and a blind replace would drop them.
        setMessages((current) => {
          const anchor = current.findIndex((message) => message.id === assistantId);
          const tail = anchor >= 0
            ? current.slice(anchor + 1).filter((message) => !mapped.some((item) => item.id === message.id))
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

  async function runLegacyChat(content: string, messageContext?: Record<string, unknown>) {
    const res = await fetch("/api/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentRunId,
        message: content,
        history: messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        ...(messageContext ? { messageContext } : {}),
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Agent chat failed");
    }

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
    // Legacy planner: proposals/toolRuns stay inline in the message feed.
    // The right-hand Resource Panel is no longer auto-populated from them.
  }

  async function sendMessage(
    nextMessage?: string,
    opts?: { attachments?: AgentInvoiceStagingAttachment[] },
  ) {
    const pendingAttachments = opts?.attachments
      ?? (nextMessage ? [] : getActiveInvoiceQueue(invoiceStagingAttachments));
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
    const invoiceResolved = resolveSendMessageWithInvoiceStaging({
      draft: nextMessage ?? draft,
      attachments: pendingAttachments,
      includeAttachments: true,
    });
    // loadingMessages: sending while the session detail is still loading would
    // let the in-flight load overwrite the freshly appended messages.
    if (busy || loadingMessages) return;
    // 草稿为空且两类附件都为空 → 无可发送内容。
    if (!invoiceResolved && pendingGeneric.length === 0) return;
    let content = invoiceResolved?.content ?? "";
    if (!content && pendingGeneric.length > 0) content = DEFAULT_ATTACHMENT_ONLY_MESSAGE;
    if (!content) return;
    // 合并 invoice + generic 附件到 messageContext（generic 以原生多模态进入 runtime）。
    const messageContext: Record<string, unknown> = { ...(invoiceResolved?.messageContext ?? {}) };
    if (pendingGeneric.length > 0) {
      Object.assign(messageContext, buildAgentAttachmentMessageContext(pendingGeneric));
    }
    const effectiveMessageContext = Object.keys(messageContext).length > 0 ? messageContext : undefined;

    const requestToken = ++requestTokenRef.current;
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
    // 通用附件随本条消息发出后清空队列（发票队列由 proposal 事件推进，保留）。
    if (pendingGeneric.length > 0) setGenericAttachments([]);
    // 保留队列：发送后继续展示进度，由 tool/proposal 事件更新状态。
    // 中断/失败时队列本身未清空，无需恢复附件。
    setBusy(true);
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

    try {
      // 已知 legacy 模式：跳过 chat-stream，直走 legacy（每页一次判定后零 RTT）。
      // 通用附件门禁已在上方拦截；这里只可能是纯文本 / 发票 staging 消息。
      if (runtimeModeRef.current === "legacy") {
        setRuntimeStatus("degraded");
        setMessages((current) => current.filter((m) => m.id !== assistantMessage.id));
        await runLegacyChat(content, effectiveMessageContext);
        return;
      }
      const result = await runPiStream(
        content,
        userMessage,
        assistantMessage.id,
        requestToken,
        streamController.signal,
        effectiveMessageContext,
      );
      if (requestToken !== requestTokenRef.current) return;

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
        // 移除本轮占位 assistant 消息后直走 legacy（user 消息保留）。
        setMessages((current) => current.filter((m) => m.id !== assistantMessage.id));
        await runLegacyChat(content, effectiveMessageContext);
      } else {
        // B/C/未知 409：conflict，fail-closed 不回退。
        setRuntimeStatus("available");
        rollbackAttachmentConflict();
        toast.error(result.message || "附件已失效，请重新上传后再发送");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        if (requestToken === requestTokenRef.current && userStoppedRef.current) {
          // 用户主动停止：收尾时间线，留下「已停止」提示；不回填草稿（消息已发出）。
          setMessages((current) => finishRunningTimeline(current, assistantMessage.id, {
            state: "done",
            content: "已停止本次生成。",
          }));
        } else if (requestToken === requestTokenRef.current) {
          setDraft(previousDraft);
        }
        return;
      }
      if (requestToken === requestTokenRef.current) {
        setDraft(previousDraft);
        setMessages((current) => finishRunningTimeline(current, assistantMessage.id, {
          state: "error",
          content: "这次没有成功返回结果。你可以稍后重试，或者换一种问法。",
        }));
      }
      toast.error(error instanceof Error ? error.message : "Agent chat failed");
    } finally {
      if (requestToken === requestTokenRef.current) {
        setBusy(false);
      }
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

  async function compactConversation() {
    if (!activeSessionId || compactBusy || busy) return;
    setCompactBusy(true);
    try {
      const res = await fetch("/api/agent/chat-compact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: activeSessionId }),
      });
      const data = await res.json();
      if (res.status === 409) {
        toast.message("当前还是 legacy runtime，暂未启用服务端 compact。");
        return;
      }
      if (!res.ok) {
        throw new Error(data.error || "Compact failed");
      }
      toast.success("上下文摘要已更新");
      await refreshSessions();
      const detailRes = await fetch(`/api/agent/chat-sessions/${activeSessionId}`);
      if (detailRes.ok) {
        const detail = await detailRes.json() as { session: AgentChatSessionDetail };
        setMessages(detail.session.messages.map(mapSessionMessage));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "上下文压缩失败");
    } finally {
      setCompactBusy(false);
    }
  }

  async function applyViewIntent(intent: AgentViewIntent) {
    // focus_entity / open_panel with entity: prefer opening in the workspace
    // Resource Panel (desktop) instead of navigating away.  We still POST to
    // the view-intents apply route for navigate/set_filter/open_panel(panel=*)
    // which have no entity target.
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
      if (!res.ok) {
        throw new Error(data.error || "视图切换失败");
      }

      if (data.applied?.mode === "navigate" && typeof data.applied.route === "string") {
        const url = new URL(data.applied.route, window.location.origin);
        if (data.applied.searchParams && typeof data.applied.searchParams === "object") {
          for (const [key, value] of Object.entries(data.applied.searchParams as Record<string, unknown>)) {
            if (value !== null && value !== undefined) {
              url.searchParams.set(key, String(value));
            }
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

  function startNewConversation() {
    if (busy || proposalBusyId) return;
    requestTokenRef.current += 1;
    streamAbortRef.current?.abort();
    setActiveSessionId(null);
    setAgentRunId(null);
    setMessages([]);
    setDraft("");
    setInvoiceStagingAttachments([]);
    setBusy(false);
    // Note: Resource Panel is intentionally NOT closed here.  Per the plan,
    // switching sessions does not auto-close an explicitly opened resource.
  }

  function selectSession(sessionId: string) {
    if (sessionId === activeSessionId || busy || proposalBusyId) return;
    requestTokenRef.current += 1;
    streamAbortRef.current?.abort();
    setActiveSessionId(sessionId);
    setBusy(false);
  }

  async function handleDeleteSession(sessionId: string) {
    // 生成中不允许删除当前会话（流还在写它）；删其他会话不受影响。
    if ((busy || proposalBusyId) && sessionId === activeSessionId) return;
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

  const messageActions: AgentMessageActions = {
    onConfirmProposal: (proposalId) => void confirmProposal(proposalId),
    onRejectProposal: (proposalId) => void rejectProposal(proposalId),
    onUpdateProposal: updateProposal,
    onApplyViewIntent: (intent) => void applyViewIntent(intent),
    onOpenResource: (request, options) =>
      void resourceNavigation.openResource(request, options?.target),
    onCreateProposal: createProposal,
    onSendPrefilled: (value) => void sendMessage(value),
    onUseFollowUp: (value) => void sendMessage(value),
    // P1-3 UI 接线：needs-user-confirmation 卡片据此 mint AgentUserConfirmationEvent。
    agentRunId: agentRunId ?? null,
  };

  if (status === "loading") {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!session) return null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/40 p-3 lg:p-4">
      <div className={`grid min-h-0 flex-1 gap-3 ${resourceCollapsed ? "grid-cols-[minmax(0,1fr)_3rem]" : "grid-cols-[minmax(0,55fr)_minmax(20rem,45fr)]"}`}>
        <AgentChatPanel
          messages={messages}
          draft={draft}
          busy={busy}
          loadingMessages={loadingMessages}
          compactBusy={compactBusy}
          agentRunId={agentRunId}
          sessionId={activeSessionId}
          sessions={sessions}
          sessionsLoading={sessionsLoading}
          proposalBusyId={proposalBusyId}
          userName={session.user.name}
          asrEnabled={asrEnabled}
          surface="desktop"
          genuiEnabled={genuiEnabled}
          messageActions={messageActions}
          onDraftChange={setDraft}
          onSend={() => void sendMessage()}
          onStop={busy ? stopStreaming : undefined}
          onCompact={activeSessionId ? () => void compactConversation() : undefined}
          onSelectSession={selectSession}
          onNewSession={startNewConversation}
          onDeleteSession={(id) => void handleDeleteSession(id)}
          onVoiceTranscribe={asrEnabled ? handleVoiceTranscribe : undefined}
          onVoiceSend={(transcript) => void sendMessage(transcript)}
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
          runtimeStatus={runtimeStatus}
        />

        <AgentResourcePanel
          navigation={resourceNavigation}
          collapsed={resourceCollapsed}
          onToggleCollapse={() => setResourceCollapsed((v) => !v)}
        />
      </div>
    </div>
  );
}
