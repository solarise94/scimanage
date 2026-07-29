"use client";

import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import {
  ChevronDown,
  ImagePlus,
  Keyboard,
  Loader2,
  Mic,
  Paperclip,
  Plus,
  SendHorizontal,
  Square,
  WandSparkles,
} from "lucide-react";
import type { AgentChatMessageAttachment, AgentTimelineItem } from "@/lib/agent-runtime/types";
import type { AgentInvoiceStagingAttachment } from "@/lib/agent/invoice-staging-attachment";
import { AGENT_INVOICE_STAGING_MAX_FILES } from "@/lib/agent/invoice-staging-attachment";
import { AgentInvoiceAttachmentList } from "@/components/agent/agent-invoice-attachment-list";
import { AgentAttachmentChips } from "@/components/agent/agent-attachment-chips";
import {
  AGENT_ATTACHMENT_ACCEPT,
  AGENT_ATTACHMENT_MAX_FILES,
  type AgentGenericAttachment,
} from "@/lib/agent/agent-attachment-upload";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useElementHeight } from "@/hooks/use-element-height";
import { VoiceHoldButton } from "./voice-hold-button";
import { AgentSessionList, type AgentSessionSummary } from "./agent-session-sheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AgentMessageFeed, type AgentMessageActions, type AgentSurface } from "./agent-message-feed";
import {
  RUNTIME_STATUS_COLORS,
  RUNTIME_STATUS_LABELS,
  type AgentRuntimeStatus,
} from "@/lib/agent/runtime-status";

export interface AgentToolRun {
  actionKey: string;
  reason?: string;
  input: Record<string, unknown>;
  status: "done" | "error";
  result?: unknown;
  error?: string;
}

export interface AgentChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  state?: string;
  timeline?: AgentTimelineItem[];
  toolRuns?: AgentToolRun[];
  followUps?: string[];
  proposals?: AgentProposal[];
  /** 用户消息携带的通用附件（文件卡片）；历史来自 AgentChatAttachmentLink，发送时为乐观数据。 */
  attachments?: AgentChatMessageAttachment[];
}

export interface AgentProposal {
  id: string;
  agentRunId?: string | null;
  actionKey: string;
  title: string;
  summary: string;
  riskLevel: "safe" | "confirm" | "restricted";
  status: string;
  input: Record<string, unknown>;
  result?: unknown;
  error?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  displayProps?: Record<string, string | null>;
  createdAt: string;
  decidedAt?: string | null;
}

export interface AgentRunSummary {
  id: string;
  userId: string;
  role: string;
  name?: string | null;
  email?: string | null;
  status: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string;
}

const DEFAULT_SUGGESTIONS = [
  "帮我找最近待回款的订单",
  "查一下最近活跃的 CRM 客户",
  "汇总本周项目状态变化",
  "帮我新建一个跟进任务",
];

/**
 * Desktop chat chrome: session switcher + shared message feed + simplified composer.
 * Message/Markdown/GenUI semantics come from AgentMessageFeed (same as mobile).
 */
export function AgentChatPanel({
  messages,
  draft,
  busy,
  loadingMessages,
  compactBusy,
  agentRunId,
  sessionId,
  sessions = [],
  sessionsLoading = false,
  proposalBusyId,
  userName,
  asrEnabled,
  surface = "desktop",
  genuiEnabled = true,
  suggestions = DEFAULT_SUGGESTIONS,
  messageActions,
  onDraftChange,
  onSend,
  onStop,
  onCompact,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onVoiceTranscribe,
  onVoiceSend,
  invoiceStagingEnabled = false,
  invoiceStagingAttachments = [],
  invoiceStagingUploading = false,
  onInvoiceStagingSelected,
  onInvoiceStagingClear,
  onInvoiceStagingRemove,
  genericAttachments = [],
  genericUploading = false,
  onGenericFilesSelected,
  onGenericAttachmentRemove,
  runtimeStatus,
}: {
  messages: AgentChatMessage[];
  draft: string;
  busy: boolean;
  loadingMessages?: boolean;
  compactBusy?: boolean;
  agentRunId?: string | null;
  sessionId?: string | null;
  sessions?: AgentSessionSummary[];
  sessionsLoading?: boolean;
  proposalBusyId?: string | null;
  userName?: string | null;
  asrEnabled?: boolean;
  surface?: AgentSurface;
  genuiEnabled?: boolean;
  suggestions?: string[];
  messageActions: AgentMessageActions;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  /** 流式生成中显示停止按钮，点击中断当前任务。 */
  onStop?: () => void;
  onCompact?: () => void;
  onSelectSession?: (sessionId: string) => void;
  onNewSession?: () => void;
  /** 提供时会话列表每行显示删除按钮（确认逻辑由调用方处理）。 */
  onDeleteSession?: (sessionId: string) => void;
  onVoiceTranscribe?: (blob: Blob) => Promise<string>;
  onVoiceSend?: (transcript: string) => void;
  /** ADMIN-only: allow attaching issued-invoice files for staging upload (max 10). */
  invoiceStagingEnabled?: boolean;
  invoiceStagingAttachments?: AgentInvoiceStagingAttachment[];
  invoiceStagingUploading?: boolean;
  onInvoiceStagingSelected?: (files: FileList | File[]) => void;
  onInvoiceStagingClear?: () => void;
  onInvoiceStagingRemove?: (stagingFileId: string) => void;
  /** 通用附件队列（选择/拖放/粘贴），原生多模态进入 Agent。 */
  genericAttachments?: AgentGenericAttachment[];
  genericUploading?: boolean;
  onGenericFilesSelected?: (files: File[]) => void;
  onGenericAttachmentRemove?: (stagingFileId: string) => void;
  /** 桌面顶栏运行时状态点（仅桌面渲染；移动端在 AgentMobileHeader 内自渲染）。 */
  runtimeStatus?: AgentRuntimeStatus;
}) {
  const [sessionSheetOpen, setSessionSheetOpen] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const invoiceFileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const composerHeight = useElementHeight(composerRef, 96);

  // 单行起步、随内容长高：field-sizing 在部分浏览器表现不一致，用 scrollHeight 兜底。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  const voiceAvailable = Boolean(asrEnabled && onVoiceTranscribe);
  // 空会话：输入卡垂直居中（ChatGPT 风格），首条消息发出后滑动到底部。
  const isEmptyState = messages.length === 0 && !loadingMessages;
  const activeSession = sessions.find((item) => item.id === sessionId);
  const sessionTitle = activeSession?.title?.trim()
    || (sessionId ? `会话 ${sessionId.slice(-8)}` : "新会话");
  const canSend = Boolean(
    (draft.trim() || invoiceStagingAttachments.length > 0 || genericAttachments.length > 0)
    && !busy
    && !transcribing
    && !invoiceStagingUploading
    && !genericUploading,
  );

  // ── 通用附件：选择 / 拖放 / 粘贴（docs §3.1）──
  const genericFileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);

  const genericInputEnabled = Boolean(onGenericFilesSelected);

  function handleGenericFileList(list: FileList | File[] | null | undefined) {
    if (!onGenericFilesSelected || !list) return;
    const files = Array.from(list).slice(0, AGENT_ATTACHMENT_MAX_FILES);
    if (files.length > 0) onGenericFilesSelected(files);
  }

  function handleComposerDrop(event: DragEvent) {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    if (!genericInputEnabled || busy || genericUploading) return;
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) handleGenericFileList(files);
  }

  function handleComposerPaste(event: ClipboardEvent) {
    if (!genericInputEnabled || busy || genericUploading) return;
    const items = event.clipboardData?.items;
    if (!items) return;
    const pastedImages: File[] = [];
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file && file.type.startsWith("image/")) pastedImages.push(file);
      }
    }
    // 仅当剪贴板含图片时拦截；纯文本粘贴保持浏览器原行为。
    if (pastedImages.length > 0) {
      event.preventDefault();
      handleGenericFileList(pastedImages);
    }
  }

  function handleVoiceTranscribe(blob: Blob): Promise<string> {
    if (!onVoiceTranscribe) return Promise.reject(new Error("语音识别不可用"));
    setTranscribing(true);
    return onVoiceTranscribe(blob).finally(() => setTranscribing(false));
  }

  function handleVoiceSend(transcript: string) {
    if (onVoiceSend) {
      onVoiceSend(transcript);
      return;
    }
    onDraftChange(draft ? `${draft} ${transcript}` : transcript);
    setVoiceMode(false);
  }

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl bg-muted/30 shadow-sm">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/50 px-4 py-2.5">
        <div className="min-w-0 flex-1">
          {onSelectSession ? (
            /* 桌面端：会话切换走标题按钮的下拉 Popover（移动端用底部 Sheet） */
            <Popover open={sessionSheetOpen} onOpenChange={setSessionSheetOpen}>
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    className="flex max-w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-muted/50"
                  />
                }
              >
                <span className="truncate text-sm font-medium">{sessionTitle}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                {runtimeStatus ? (
                  <span
                    className={cn("h-2 w-2 shrink-0 rounded-full", RUNTIME_STATUS_COLORS[runtimeStatus])}
                    title={`Runtime ${RUNTIME_STATUS_LABELS[runtimeStatus]}`}
                  />
                ) : null}
              </PopoverTrigger>
              <PopoverContent align="start" sideOffset={6} className="w-80 gap-0 p-1.5">
                <div className="max-h-[46vh] overflow-y-auto">
                  <AgentSessionList
                    compact
                    sessions={sessions}
                    activeSessionId={sessionId ?? null}
                    loading={sessionsLoading}
                    onSelect={(id) => {
                      onSelectSession(id);
                      setSessionSheetOpen(false);
                    }}
                    onDelete={onDeleteSession}
                  />
                </div>
                {onNewSession ? (
                  <div className="mt-1.5 border-t border-border/50 pt-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => {
                        setSessionSheetOpen(false);
                        onNewSession();
                      }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      新建会话
                    </Button>
                  </div>
                ) : null}
              </PopoverContent>
            </Popover>
          ) : (
            <div className="px-1.5 text-sm font-medium">Agent 对话</div>
          )}
          <div className="px-1.5 text-[11px] text-muted-foreground">
            {sessionId ? `ID ${sessionId.slice(-8)}` : "新会话"}
            {agentRunId ? ` · Run ${agentRunId.slice(-8)}` : ""}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {onCompact ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 rounded-lg px-2.5"
              disabled={busy || compactBusy}
              onClick={onCompact}
            >
              {compactBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <WandSparkles className="h-3.5 w-3.5" />}
              Compact
            </Button>
          ) : null}
          {onNewSession ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 rounded-lg"
              disabled={busy || proposalBusyId != null}
              onClick={onNewSession}
            >
              <Plus className="h-3.5 w-3.5" />
              新会话
            </Button>
          ) : null}
        </div>
      </header>

      {/* 消息区 + 悬浮输入卡：输入卡浮在消息流之上，消息可滑入其下方（feed 自带渐隐 mask） */}
      <div className="relative min-h-0 flex-1">
        <AgentMessageFeed
          messages={messages}
          loading={loadingMessages}
          busy={busy}
          userName={userName}
          proposalBusyId={proposalBusyId}
          surface={surface}
          genuiEnabled={genuiEnabled}
          actions={messageActions}
          suggestions={suggestions}
          className="h-full"
          contentClassName="max-w-3xl sm:px-4"
          maxWidthClass="max-w-3xl"
          bottomInset={composerHeight}
          hideEmptyState={isEmptyState}
        />

        {/* ChatGPT 风格悬浮胶囊输入卡：空会话垂直居中，发出首条消息后滑到底部。
            上下弹性 spacer 的 flex 过渡实现滑动动画；遮罩层不拦截消息区交互。 */}
        <div className="pointer-events-none absolute inset-0 flex flex-col px-3 pb-3 sm:px-4">
          <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
            {/* 顶部 spacer 恒为 flex-1：非空态把输入卡推到底部；空态时底部 spacer 同步撑起，实现垂直居中 */}
            <div className="flex-[1]" />

            {isEmptyState ? (
              <div className="pointer-events-auto pb-4 text-center">
                <h2 className="text-xl font-medium tracking-tight">准备好了，随时开始</h2>
              </div>
            ) : null}

            <div
              ref={composerRef}
              className="pointer-events-auto relative w-full shrink-0"
              onDragEnter={(event) => {
                if (!genericInputEnabled) return;
                event.preventDefault();
                dragDepthRef.current += 1;
                setDragActive(true);
              }}
              onDragOver={(event) => {
                if (!genericInputEnabled) return;
                event.preventDefault();
              }}
              onDragLeave={(event) => {
                if (!genericInputEnabled) return;
                event.preventDefault();
                dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
                if (dragDepthRef.current === 0) setDragActive(false);
              }}
              onDrop={handleComposerDrop}
              onPaste={handleComposerPaste}
            >
        {dragActive && genericInputEnabled ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-background/80 text-sm text-primary">
            松开以上传到 Agent
          </div>
        ) : null}
        {transcribing ? (
          <div className="mb-2 flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            语音识别中 · 完成后自动发送
          </div>
        ) : null}

        <AgentInvoiceAttachmentList
          attachments={invoiceStagingAttachments}
          uploading={invoiceStagingUploading}
          busy={busy}
          onClearAll={onInvoiceStagingClear}
          onClearOne={onInvoiceStagingRemove}
        />

        <AgentAttachmentChips
          attachments={genericAttachments}
          uploading={genericUploading}
          onRemove={onGenericAttachmentRemove}
          disabled={busy}
        />
        {genericInputEnabled ? (
          <input
            ref={genericFileInputRef}
            type="file"
            accept={AGENT_ATTACHMENT_ACCEPT}
            multiple
            className="hidden"
            onChange={(event) => {
              handleGenericFileList(event.target.files);
              event.target.value = "";
            }}
          />
        ) : null}

        <div className="rounded-[26px] bg-background shadow-md transition-shadow focus-within:shadow-lg">
          {voiceAvailable && voiceMode ? (
            <div className="px-3 pt-3">
              <VoiceHoldButton
                onTranscribe={handleVoiceTranscribe}
                onSend={handleVoiceSend}
                disabled={busy}
              />
            </div>
          ) : (
            <Textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              placeholder={
                transcribing
                  ? "识别中…"
                  : invoiceStagingAttachments.length > 0
                    ? invoiceStagingAttachments.length > 1
                      ? `已附 ${invoiceStagingAttachments.length} 张发票，发送后将按顺序识别登记`
                      : "可补充说明，或直接发送以识别并登记发票"
                    : "给 Agent 发消息"
              }
              rows={1}
              className={cn(
                "min-h-[24px] max-h-[160px] w-full resize-none overflow-y-auto rounded-none border-transparent bg-transparent px-4 pb-1 pt-3 text-sm leading-6 shadow-none focus-visible:border-transparent focus-visible:ring-0",
                transcribing && "opacity-60",
              )}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  if (canSend) onSend();
                }
              }}
              disabled={transcribing}
            />
          )}

          <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1">
            <div className="flex items-center gap-1">
              {invoiceStagingEnabled ? (
                <>
                  <input
                    ref={invoiceFileInputRef}
                    type="file"
                    accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      const files = event.target.files;
                      event.target.value = "";
                      if (files && files.length > 0 && onInvoiceStagingSelected) {
                        onInvoiceStagingSelected(files);
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 shrink-0 rounded-full"
                    onClick={() => invoiceFileInputRef.current?.click()}
                    disabled={
                      busy
                      || transcribing
                      || invoiceStagingUploading
                      || invoiceStagingAttachments.length >= AGENT_INVOICE_STAGING_MAX_FILES
                    }
                    aria-label="上传发票附件"
                    title="上传已开发票（最多 10 张，PDF/JPG/PNG）"
                  >
                    {invoiceStagingUploading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Paperclip className="h-4 w-4" />
                    )}
                  </Button>
                </>
              ) : null}
              {genericInputEnabled ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0 rounded-full"
                  onClick={() => genericFileInputRef.current?.click()}
                  disabled={
                    busy
                    || transcribing
                    || genericUploading
                    || genericAttachments.length >= AGENT_ATTACHMENT_MAX_FILES
                  }
                  aria-label="上传附件"
                  title="上传图片或文件（最多 5 个；JPEG/PNG/WebP/PDF/DOCX/XLSX/TXT/CSV）"
                >
                  {genericUploading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ImagePlus className="h-4 w-4" />
                  )}
                </Button>
              ) : null}
            </div>

            <div className="flex items-center gap-1.5">
              {voiceAvailable ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0 rounded-full"
                  onClick={() => setVoiceMode((value) => !value)}
                  disabled={busy || transcribing}
                  aria-label={voiceMode ? "切换到键盘输入" : "切换到语音输入"}
                >
                  {voiceMode ? <Keyboard className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </Button>
              ) : null}

              {/* 生成中：发送键变停止键；语音模式：发送键保留但灰色禁用（不抓取视觉焦点） */}
              {busy && onStop ? (
                <Button
                  size="icon"
                  variant="outline"
                  onClick={onStop}
                  className="h-9 w-9 shrink-0 rounded-full"
                  aria-label="停止生成"
                  title="停止生成"
                >
                  <Square className="h-3.5 w-3.5 fill-current" />
                </Button>
              ) : (
                <Button
                  size="icon"
                  onClick={onSend}
                  disabled={!canSend || (voiceAvailable && voiceMode)}
                  className="h-9 w-9 shrink-0 rounded-full"
                >
                  <SendHorizontal className="h-4 w-4" />
                  <span className="sr-only">发送</span>
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="mt-1.5 flex items-center justify-between px-2 text-[11px] text-muted-foreground">
          <span>{userName ? userName : "已登录"}</span>
          <span>Ctrl/Cmd + Enter 发送</span>
        </div>
            </div>

            {isEmptyState ? (
              <div className="pointer-events-auto mt-3 flex flex-wrap items-center justify-center gap-2">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => messageActions.onUseFollowUp(suggestion)}
                    className="rounded-full border border-border/50 bg-background px-3.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            ) : null}

            <div className={cn("transition-all duration-500 ease-out", isEmptyState ? "flex-[1]" : "flex-[0]")} />
          </div>
        </div>
      </div>
    </section>
  );
}
