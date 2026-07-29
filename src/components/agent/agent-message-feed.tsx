"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, CircleAlert, Copy, Loader2, Share2, Sparkles, Wrench } from "lucide-react";
import { toast } from "sonner";
import type { AgentTimelineItem, AgentViewIntent } from "@/lib/agent-runtime/types";
import type { AgentResourceRequest } from "@/lib/agent-resources/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { copyTextToClipboard, shareText } from "@/lib/agent/clipboard-share";
import { AgentMarkdown } from "./agent-markdown";
import {
  type AgentSurface,
  shouldRenderInlineProposals,
  shouldRenderInlineSuccessTool,
} from "./agent-presentation";
import { AgentUiRenderer, hasAgentUiCard } from "./agent-ui-registry";
import { AgentMessageAttachmentCards } from "./agent-message-attachment-cards";
import { ensureCardsRegistered } from "./cards";
import { AgentNeedsUserConfirmationCard } from "./cards/needs-user-confirmation-card";
import { friendlyToolLabel } from "./tool-display";
import type { AgentChatMessage, AgentProposal, AgentToolRun } from "./chat-panel";
import {
  formatMessageDateLabel,
  formatMessageTime,
  humanizeToolError,
  isSameMessageDay,
  normalizeAssistantText,
  shouldRenderNeedsConfirmation,
  shouldShowAssistantActions,
} from "./agent-message-helpers";

ensureCardsRegistered();

export type { AgentSurface };

export type AgentMessageActions = {
  onConfirmProposal: (id: string) => void;
  onRejectProposal: (id: string) => void;
  onUpdateProposal: (id: string, input: Record<string, unknown>) => Promise<AgentProposal>;
  onApplyViewIntent: (intent: AgentViewIntent) => void;
  /**
   * Open a business resource in the Agent workspace (desktop Panel / mobile
   * Sheet).  Optional — shells that haven't wired up the Resource Panel yet
   * fall back to full-page navigation via onApplyViewIntent.
   */
  onOpenResource?: (
    request: AgentResourceRequest,
    options?: { target?: "workspace" | "page" },
  ) => void;
  onCreateProposal?: (actionKey: string, input: Record<string, unknown>) => Promise<AgentProposal | null>;
  onSendPrefilled?: (message: string, context?: Record<string, unknown>) => void;
  onCardDirtyChange?: (cardId: string, dirty: boolean) => void;
  onUseFollowUp: (value: string) => void;
  /**
   * P1-3 UI 接线：当前会话绑定的 AgentRun id（workbench / mobile-shell 都有 state，
   * 来自 loadSessionDetail / x-agent-run-id 响应头）。needs-user-confirmation 卡片
   * 据此 mint 匹配的 AgentUserConfirmationEvent。null/undefined 时卡片按钮禁用并提示。
   */
  agentRunId?: string | null;
};

export function AgentProcessStatusRow({
  icon,
  label,
  detail,
  active = false,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  active?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-0.5 py-0.5 text-[12px]",
        active ? "text-muted-foreground" : "text-muted-foreground/80",
      )}
    >
      <span className="shrink-0 opacity-80">{icon}</span>
      <span className={cn("font-medium", active && "text-foreground/80")}>{label}</span>
      {detail ? <span className="min-w-0 truncate opacity-70">{detail}</span> : null}
      {active ? (
        <span className="ml-0.5 inline-flex items-center gap-0.5">
          <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground/70" style={{ animationDelay: "0ms" }} />
          <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground/70" style={{ animationDelay: "120ms" }} />
          <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground/70" style={{ animationDelay: "240ms" }} />
        </span>
      ) : null}
    </div>
  );
}

function AgentAssistantStream({
  items,
  messageState,
  surface,
  genuiEnabled,
  proposalBusyId,
  actions,
}: {
  items: AgentTimelineItem[];
  messageState?: string;
  surface: AgentSurface;
  genuiEnabled: boolean;
  proposalBusyId?: string | null;
  actions: AgentMessageActions;
}) {
  const isStreaming = messageState === "streaming";
  const showInlineSuccess = shouldRenderInlineSuccessTool(surface, genuiEnabled);
  // 单数组按时间序渲染：文本与工具调用行穿插（ChatGPT agent 风格），
  // 工具调用收敛为一行紧凑 muted 行，不再用重型卡片堆叠。
  const nodes: ReactNode[] = [];

  for (const item of items) {
    if (item.kind === "thinking") {
      if (item.status === "running" || (isStreaming && item.status !== "done" && item.status !== "error")) {
        nodes.push(
          <AgentProcessStatusRow
            key={item.id}
            icon={<Loader2 className="h-3.5 w-3.5 animate-spin" />}
            label="正在思考"
            active
          />,
        );
      }
      continue;
    }

    if (item.kind === "tool") {
      const label = friendlyToolLabel(item.toolName, item.label);
      if (item.status === "running") {
        nodes.push(
          <AgentProcessStatusRow
            key={item.id}
            icon={<Wrench className="h-3.5 w-3.5" />}
            label="正在执行"
            detail={label}
            active
          />,
        );
        continue;
      }

      if (item.status === "error") {
        // P1-3 UI 接线：NEEDS_USER_CONFIRMATION 不渲染红色错误行，改渲染确认卡片
        // （引导用户 mint AgentUserConfirmationEvent 并重试）。genuiEnabled=false 时
        // 退化为文本提示行（参照现有 GenUI 退化模式）。
        if (shouldRenderNeedsConfirmation(item)) {
          if (genuiEnabled) {
            nodes.push(
              <div key={item.id} className="w-full">
                <AgentNeedsUserConfirmationCard
                  label={label}
                  targetIntent={item.targetIntent}
                  agentRunId={actions.agentRunId}
                  onConfirmed={() =>
                    actions.onSendPrefilled?.("我已确认，请重新执行刚才的操作")
                  }
                />
              </div>,
            );
          } else {
            nodes.push(
              <div
                key={item.id}
                className="flex items-start gap-2 px-0.5 py-0.5 text-[12px] text-muted-foreground"
              >
                <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-80" />
                <div className="min-w-0 break-words">
                  <span className="font-medium">{label}</span>
                  <span className="opacity-80"> · 该操作需要你的明确确认才能生成提案</span>
                </div>
              </div>,
            );
          }
          continue;
        }
        nodes.push(
          <div
            key={item.id}
            className="flex items-start gap-2 px-0.5 py-0.5 text-[12px] text-rose-600 dark:text-rose-400"
          >
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-80" />
            <div className="min-w-0 break-words">
              <span className="font-medium">{label} 失败</span>
              {item.error ? (
                <span className="opacity-80"> · {humanizeToolError(item.error)}</span>
              ) : null}
            </div>
          </div>,
        );
        continue;
      }

      // 成功工具：注册了 GenUI 卡片的渲染卡片（客户名片、选择卡等），
      // 其余（含无卡片的工具）只留一行紧凑记录，不再渲染白色 fallback 卡。
      if (item.status === "done" && showInlineSuccess && hasAgentUiCard(item.toolName, item.input, item.output, "success")) {
        nodes.push(
          <div key={item.id} className="w-full">
            <AgentUiRenderer
              actionKey={item.toolName}
              input={item.input}
              output={item.output}
              status="success"
              fallbackCardId={item.id}
              proposalBusyId={proposalBusyId}
              onConfirmProposal={actions.onConfirmProposal}
              onRejectProposal={actions.onRejectProposal}
              onUpdateProposal={actions.onUpdateProposal}
              onApplyViewIntent={actions.onApplyViewIntent}
              onOpenResource={actions.onOpenResource}
              onCreateProposal={actions.onCreateProposal}
              onSendPrefilled={actions.onSendPrefilled}
              onCardDirtyChange={actions.onCardDirtyChange}
            />
          </div>,
        );
      } else if (item.status === "done") {
        nodes.push(
          <AgentProcessStatusRow
            key={item.id}
            icon={<Wrench className="h-3.5 w-3.5" />}
            label={label}
          />,
        );
      }
      continue;
    }

    if (item.kind === "text") {
      const content = normalizeAssistantText(item.content || "");
      if (!content) continue;
      nodes.push(
        <div key={item.id} className="break-words px-0.5 text-[15px] leading-7 text-foreground">
          <AgentMarkdown
            content={content}
            className="text-[15px] leading-7"
            onOpenResource={actions.onOpenResource ? (req) => actions.onOpenResource!(req) : undefined}
          />
        </div>,
      );
      continue;
    }

    if (item.kind === "compact") {
      if (item.status === "running") {
        nodes.push(
          <AgentProcessStatusRow
            key={item.id}
            icon={<Loader2 className="h-3.5 w-3.5 animate-spin" />}
            label="正在压缩上下文"
            active
          />,
        );
      }
      continue;
    }

    if (item.kind === "view") {
      nodes.push(
        <div
          key={item.id}
          className="rounded-xl bg-card px-3.5 py-2.5 text-xs shadow-sm"
        >
          <div className="font-medium text-sm">{item.intent.label}</div>
          {item.intent.reason ? <div className="mt-0.5 text-muted-foreground">{item.intent.reason}</div> : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2 h-8 rounded-lg px-3 text-[11px]"
            onClick={() => actions.onApplyViewIntent(item.intent)}
          >
            应用视图
          </Button>
        </div>,
      );
      continue;
    }
  }

  if (nodes.length === 0) return null;
  return <div className="flex w-full flex-col gap-2.5">{nodes}</div>;
}

function ProposalCard({
  proposal,
  proposalBusyId,
  actions,
}: {
  proposal: AgentProposal;
  proposalBusyId?: string | null;
  actions: AgentMessageActions;
}) {
  return (
    <AgentUiRenderer
      actionKey={proposal.actionKey}
      input={proposal.input}
      output={proposal.result}
      proposal={proposal}
      status={
        proposal.status === "PENDING"
          ? "pending_confirmation"
          : proposal.status === "PROCESSING"
            ? "running"
            : proposal.status === "CONFIRMED"
              ? "success"
              : "error"
      }
      proposalBusyId={proposalBusyId}
      onConfirmProposal={actions.onConfirmProposal}
      onRejectProposal={actions.onRejectProposal}
      onUpdateProposal={actions.onUpdateProposal}
      onApplyViewIntent={actions.onApplyViewIntent}
      onOpenResource={actions.onOpenResource}
      onCreateProposal={actions.onCreateProposal}
      onSendPrefilled={actions.onSendPrefilled}
      onCardDirtyChange={actions.onCardDirtyChange}
    />
  );
}

function LegacyToolRunRow({
  messageId,
  toolRun,
  surface,
  genuiEnabled,
  proposalBusyId,
  actions,
}: {
  messageId: string;
  toolRun: AgentToolRun;
  surface: AgentSurface;
  genuiEnabled: boolean;
  proposalBusyId?: string | null;
  actions: AgentMessageActions;
}) {
  if (toolRun.status === "done") {
    // 无 GenUI 卡片（或桌面走信息面板）时只留一行紧凑记录。
    if (
      !shouldRenderInlineSuccessTool(surface, genuiEnabled)
      || !hasAgentUiCard(toolRun.actionKey, toolRun.input, toolRun.result, "success")
    ) {
      return (
        <AgentProcessStatusRow
          icon={<Wrench className="h-3.5 w-3.5" />}
          label={friendlyToolLabel(toolRun.actionKey)}
        />
      );
    }
    return (
      <AgentUiRenderer
        actionKey={toolRun.actionKey}
        input={toolRun.input}
        output={toolRun.result}
        status="success"
        fallbackCardId={`${messageId}-${toolRun.actionKey}`}
        proposalBusyId={proposalBusyId}
        onConfirmProposal={actions.onConfirmProposal}
        onRejectProposal={actions.onRejectProposal}
        onUpdateProposal={actions.onUpdateProposal}
        onApplyViewIntent={actions.onApplyViewIntent}
        onOpenResource={actions.onOpenResource}
        onCreateProposal={actions.onCreateProposal}
        onSendPrefilled={actions.onSendPrefilled}
        onCardDirtyChange={actions.onCardDirtyChange}
      />
    );
  }

  return (
    <div className="flex items-start gap-2 px-0.5 py-0.5 text-[12px] text-rose-600 dark:text-rose-400">
      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-80" />
      <div className="min-w-0 break-words">
        <span className="font-medium">{friendlyToolLabel(toolRun.actionKey)} 失败</span>
        {toolRun.error ? (
          <span className="opacity-80"> · {humanizeToolError(toolRun.error)}</span>
        ) : null}
      </div>
    </div>
  );
}

export function AgentMessageRow({
  message,
  userName,
  proposalBusyId,
  surface,
  genuiEnabled,
  actions,
  maxWidthClass = "max-w-full",
}: {
  message: AgentChatMessage;
  userName?: string | null;
  proposalBusyId?: string | null;
  surface: AgentSurface;
  genuiEnabled: boolean;
  actions: AgentMessageActions;
  /** Desktop can pass a wider max width for the column. */
  maxWidthClass?: string;
}) {
  const isUser = message.role === "user";
  const timeline = message.timeline ?? [];
  const hasTimelineText = timeline.some((item) => item.kind === "text" && item.content);
  const standaloneContent = isUser ? message.content : normalizeAssistantText(message.content || "");
  const showStandaloneContent = Boolean(standaloneContent) && (isUser || !hasTimelineText);
  const showInlineProposals = shouldRenderInlineProposals(surface, genuiEnabled);

  // docs Part 2 §2.3：assistant 消息（非 streaming 且有文本内容）才显示复制 / 分享。
  const showAssistantActions = !isUser && shouldShowAssistantActions(message);
  const assistantText = isUser ? "" : normalizeAssistantText(message.content || "");

  async function handleCopyMessage() {
    if (!assistantText) return;
    const ok = await copyTextToClipboard(assistantText);
    if (ok) toast.success("已复制");
    else toast.error("复制失败，请长按选择文本");
  }

  async function handleShareMessage() {
    if (!assistantText) return;
    const outcome = await shareText({ title: "SciManage Agent", text: assistantText });
    if (outcome === "fallback_copy") {
      const ok = await copyTextToClipboard(assistantText);
      if (ok) toast.success("已复制，可粘贴分享");
      else toast.error("分享不可用，且复制失败");
    }
    // "shared" / "cancelled"：均安静结束，不 toast。
  }

  return (
    <div className={cn("flex w-full py-2", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "flex min-w-0 flex-col gap-2.5",
          isUser ? "max-w-[88%] items-end" : cn("w-full items-stretch", maxWidthClass),
        )}
      >
        {isUser && message.attachments && message.attachments.length > 0 ? (
          <AgentMessageAttachmentCards attachments={message.attachments} />
        ) : null}

        {showStandaloneContent ? (
          isUser ? (
            <div className="whitespace-pre-wrap break-words rounded-3xl bg-emerald-50 px-4 py-2.5 text-sm leading-6 text-emerald-950 shadow-sm dark:bg-emerald-950/40 dark:text-emerald-50">
              {standaloneContent}
            </div>
          ) : (
            <div className="break-words px-0.5 text-[15px] leading-7 text-foreground">
              <AgentMarkdown
                content={standaloneContent}
                className="text-[15px] leading-7"
                onOpenResource={actions.onOpenResource ? (req) => actions.onOpenResource!(req) : undefined}
              />
            </div>
          )
        ) : null}

        {!isUser && timeline.length > 0 ? (
          <AgentAssistantStream
            items={timeline}
            messageState={message.state}
            surface={surface}
            genuiEnabled={genuiEnabled}
            proposalBusyId={proposalBusyId}
            actions={actions}
          />
        ) : null}

        {message.toolRuns && message.toolRuns.length > 0 ? (
          <div className="w-full space-y-2">
            {message.toolRuns.map((toolRun) => (
              <LegacyToolRunRow
                key={`${message.id}-${toolRun.actionKey}`}
                messageId={message.id}
                toolRun={toolRun}
                surface={surface}
                genuiEnabled={genuiEnabled}
                proposalBusyId={proposalBusyId}
                actions={actions}
              />
            ))}
          </div>
        ) : null}

        {showInlineProposals && message.proposals && message.proposals.length > 0 ? (
          <div className="w-full space-y-2">
            {message.proposals.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                proposalBusyId={proposalBusyId}
                actions={actions}
              />
            ))}
          </div>
        ) : null}

        {message.followUps && message.followUps.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {message.followUps.map((followUp) => (
              <button
                key={followUp}
                type="button"
                onClick={() => actions.onUseFollowUp(followUp)}
                className="rounded-lg border border-border/50 bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted/50"
              >
                {followUp}
              </button>
            ))}
          </div>
        ) : null}

        {isUser || message.state !== "streaming" ? (
          <div
            className={cn(
              "flex items-center gap-2 px-0.5 text-[10px] text-muted-foreground",
              isUser ? "justify-end" : "justify-between",
            )}
          >
            <span className={cn(isUser && "order-2")}>
              {isUser && userName ? `${userName} · ` : ""}
              {formatMessageTime(message.createdAt)}
            </span>
            {showAssistantActions ? (
              <div className="flex items-center gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-foreground"
                  onClick={handleCopyMessage}
                  aria-label="复制"
                >
                  <Copy className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-foreground"
                  onClick={handleShareMessage}
                  aria-label="分享"
                >
                  <Share2 className="h-4 w-4" />
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function AgentChatEmptyState({
  suggestions,
  onSuggestion,
  description = "新会话不继承上一会话的对话上下文，只会加载你的长期 memory 与近期热载信息。",
}: {
  suggestions: string[];
  onSuggestion: (value: string) => void;
  description?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-16">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
        <Sparkles className="h-6 w-6 text-muted-foreground" />
      </div>
      <h3 className="mt-4 text-base font-semibold tracking-tight">SciManage Agent</h3>
      <p className="mt-2 max-w-md text-center text-sm leading-6 text-muted-foreground">{description}</p>
      <div className="mt-6 flex w-full max-w-xl flex-col gap-2">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onSuggestion(suggestion)}
            className="rounded-xl border border-border/50 bg-background px-4 py-3 text-left text-sm transition-colors hover:bg-muted/40"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

export function DateSeparator({ dateStr }: { dateStr: string }) {
  return (
    <div className="flex items-center justify-center py-3">
      <span className="rounded-md bg-muted/50 px-2.5 py-0.5 text-[11px] text-muted-foreground">
        {formatMessageDateLabel(dateStr)}
      </span>
    </div>
  );
}

/**
 * Shared message list for desktop and mobile shells.
 * Only one process/loading owner: streaming assistant timeline (no extra TypingIndicator).
 */
export function AgentMessageFeed({
  messages,
  loading,
  busy,
  userName,
  proposalBusyId,
  surface = "mobile",
  genuiEnabled,
  actions,
  suggestions,
  emptyDescription,
  className,
  contentClassName,
  maxWidthClass,
  /** 悬浮输入区实测高度（px）；缺省 96 ≈ pb-24，增高时避免末条消息被遮挡。 */
  bottomInset = 96,
  /** 空会话时不渲染内置空状态（桌面居中输入卡自带问候语与建议）。 */
  hideEmptyState = false,
}: {
  messages: AgentChatMessage[];
  loading?: boolean;
  /** Disables interaction only — does not render a second loading bubble. */
  busy?: boolean;
  userName?: string | null;
  proposalBusyId?: string | null;
  surface?: AgentSurface;
  genuiEnabled: boolean;
  actions: AgentMessageActions;
  suggestions: string[];
  emptyDescription?: string;
  className?: string;
  contentClassName?: string;
  maxWidthClass?: string;
  bottomInset?: number;
  hideEmptyState?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef(true);
  const [showScrollFab, setShowScrollFab] = useState(false);
  const fadePx = Math.min(Math.max(bottomInset, 64), 120);

  // 跟随最新消息：用户上翻时不强制拉回；发出新用户消息时总是回到底部。
  useEffect(() => {
    if (!scrollRef.current) return;
    const lastIsUser = messages[messages.length - 1]?.role === "user";
    if (isAtBottomRef.current || lastIsUser) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, busy, loading]);

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

  return (
    <div className={cn("relative min-h-0 flex-1", className)}>
      {/* 底部渐隐 mask：消息可半透明地滑入悬浮输入卡下方（ChatGPT 风格） */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto overscroll-contain"
        style={{
          maskImage: `linear-gradient(to bottom, black calc(100% - ${fadePx}px), transparent 100%)`,
          WebkitMaskImage: `linear-gradient(to bottom, black calc(100% - ${fadePx}px), transparent 100%)`,
        }}
      >
      <div
        className={cn("mx-auto flex w-full flex-col px-3 py-4", contentClassName)}
        // bottomInset 只抵消输入框高度；额外 +24px 让最后一条消息与输入框之间有呼吸空间。
        style={{ paddingBottom: bottomInset + 24 }}
      >
        {messages.length === 0 && !loading && !hideEmptyState ? (
          <AgentChatEmptyState
            suggestions={suggestions}
            onSuggestion={actions.onUseFollowUp}
            description={emptyDescription}
          />
        ) : null}

        {loading && messages.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
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
                userName={userName}
                proposalBusyId={proposalBusyId}
                surface={surface}
                genuiEnabled={genuiEnabled}
                actions={actions}
                maxWidthClass={maxWidthClass}
              />
            </div>
          );
        })}
      </div>
      </div>

      {/* 回到最新 FAB：上翻后出现，点击平滑回到底部 */}
      {showScrollFab ? (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-border/60 bg-background shadow-md transition-colors hover:bg-muted"
          style={{ bottom: bottomInset }}
          aria-label="回到最新"
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}
