"use client";

import { useState } from "react";
import { Check, X, Loader2, MessageCircle, Reply, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";
import { openEntityResource } from "./open-resource";

function pickTicketTitle(props: Record<string, unknown>, summary?: string, displayProps?: Record<string, string | null>): string {
  const direct = typeof props.ticketTitle === "string" ? props.ticketTitle.trim() : "";
  if (direct) return direct;
  if (displayProps?.ticketTitle) return displayProps.ticketTitle.trim();
  if (typeof summary === "string") {
    // tickets.reply summary: 将在工单「<title>」下添加回复：「<preview>」…
    const m = summary.match(/工单「(.+?)」/);
    if (m && m[1]) return m[1].trim();
  }
  return "工单";
}

/**
 * Ticket reply draft confirm card.
 *
 * Previews a reply to a ticket (ticket title, reply content) and asks the
 * user to confirm or reject the `tickets.reply` proposal.
 */
export function TicketReplyDraftCard({
  descriptor,
  proposal,
  proposalBusyId,
  onConfirmProposal,
  onRejectProposal,
  onApplyViewIntent,
  onOpenResource,
}: AgentCardProps) {
  const ticketTitle = pickTicketTitle(descriptor.props, proposal?.summary, proposal?.displayProps as Record<string, string | null> | undefined);
  // CONFIRMED: content lives under nested `reply.content` (extractProps keeps
  // the reply object nested). PENDING: content is a flattened top-level field
  // (proposal.input after parseInput).
  const reply = (descriptor.props.reply ?? {}) as Record<string, unknown>;
  const replyContent = typeof reply.content === "string" ? reply.content.trim() : "";
  const content =
    replyContent ||
    (typeof descriptor.props.content === "string" && descriptor.props.content.trim()) ||
    "";
  const ticketId =
    (typeof reply.ticketId === "string" ? reply.ticketId : undefined)
    || (typeof descriptor.props.ticketId === "string" ? descriptor.props.ticketId : undefined);
  const isSaved = descriptor.state === "saved";
  const [saving, setSaving] = useState(false);
  const handlers = { onOpenResource, onApplyViewIntent };

  async function handleConfirm() {
    if (!proposal) return;
    setSaving(true);
    try {
      await onConfirmProposal(proposal.id);
    } finally {
      setSaving(false);
    }
  }

  if (isSaved) {
    const summary = (
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100">
          <Check className="h-5 w-5 text-emerald-600" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium">{ticketTitle}</div>
          {content ? (
            <div className="line-clamp-1 text-[11px] text-muted-foreground">{content}</div>
          ) : null}
        </div>
      </div>
    );
    return (
      <CardShell title="工单回复已发送" state="saved">
        {ticketId ? (
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 rounded-xl text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            onClick={() => openEntityResource("ticket", ticketId, "打开工单详情", handlers)}
          >
            {summary}
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" />
          </button>
        ) : (
          summary
        )}
      </CardShell>
    );
  }

  return (
    <CardShell
      title="工单回复"
      state={descriptor.state}
      footer={
        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1"
            disabled={saving || proposalBusyId === proposal?.id}
            onClick={handleConfirm}
          >
            {saving || proposalBusyId === proposal?.id ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            确认发送
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={saving || proposalBusyId === proposal?.id}
            onClick={() => proposal && onRejectProposal(proposal.id)}
          >
            <X className="h-4 w-4" />
            拒绝
          </Button>
        </div>
      }
    >
      {ticketId ? (
        <button
          type="button"
          className="flex w-full items-start gap-3 rounded-xl bg-muted/30 px-3 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          onClick={() => openEntityResource("ticket", ticketId, "打开工单详情", handlers)}
        >
          <MessageCircle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-[11px] text-muted-foreground">回复工单</div>
            <div className="text-sm font-medium">{ticketTitle}</div>
          </div>
          <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        </button>
      ) : (
        <div className="flex items-start gap-3 rounded-xl bg-muted/30 px-3 py-2">
          <MessageCircle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="text-[11px] text-muted-foreground">回复工单</div>
            <div className="text-sm font-medium">{ticketTitle}</div>
          </div>
        </div>
      )}

      <div className="mt-3">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Reply className="h-3.5 w-3.5" />
          回复内容预览
        </div>
        <div className="line-clamp-6 rounded-lg border border-border/40 bg-muted/15 px-3 py-2 text-xs leading-relaxed text-foreground whitespace-pre-wrap">
          {content || "（无内容）"}
        </div>
      </div>
    </CardShell>
  );
}
