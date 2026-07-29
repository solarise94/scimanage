"use client";

import { useState } from "react";
import { Check, X, Loader2, ArrowRight, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";
import { openEntityResource } from "./open-resource";

const STATUS_LABEL: Record<string, string> = {
  OPEN: "待处理",
  IN_PROGRESS: "处理中",
  WAITING_CUSTOMER: "待客户回复",
  RESOLVED: "已解决",
  CLOSED: "已关闭",
  REOPENED: "已重开",
};

function statusClassName(status?: string): string {
  switch (status) {
    case "OPEN":
    case "REOPENED":
      return "bg-amber-50 text-amber-700 border-amber-200";
    case "IN_PROGRESS":
      return "bg-blue-50 text-blue-700 border-blue-200";
    case "WAITING_CUSTOMER":
      return "bg-violet-50 text-violet-700 border-violet-200";
    case "RESOLVED":
    case "CLOSED":
      return "bg-emerald-50 text-emerald-700 border-emerald-200";
    default:
      return "bg-muted/60 text-muted-foreground border-border/60";
  }
}

function pickTicketTitle(props: Record<string, unknown>, summary?: string, displayProps?: Record<string, string | null>): string {
  const ticket = (props.ticket ?? {}) as Record<string, unknown>;
  const direct = typeof ticket.title === "string" ? ticket.title.trim() : "";
  if (direct) return direct;
  if (typeof props.title === "string" && props.title.trim()) return props.title.trim();
  if (typeof props.ticketTitle === "string" && props.ticketTitle.trim()) return props.ticketTitle.trim();
  if (displayProps?.ticketTitle) return displayProps.ticketTitle.trim();
  if (typeof summary === "string") {
    // tickets.update_status summary: 将工单「<title>」状态从「<from>」变更为「<to>」。
    const m = summary.match(/工单「(.+?)」/);
    if (m && m[1]) return m[1].trim();
  }
  return "工单状态更新";
}

function pickFromStatus(props: Record<string, unknown>, summary?: string, displayProps?: Record<string, string | null>): string | undefined {
  const ticket = (props.ticket ?? {}) as Record<string, unknown>;
  if (typeof ticket.previousStatus === "string") return ticket.previousStatus;
  if (typeof props.fromStatus === "string") return props.fromStatus;
  if (displayProps?.fromStatus) return displayProps.fromStatus;
  if (typeof summary === "string") {
    // summary: …状态从「<from>」变更为「<to>」。
    const m = summary.match(/从「(.+?)」/);
    if (m && m[1]) return m[1];
  }
  return undefined;
}

function statusBadge(status?: string) {
  if (!status) return null;
  return (
    <Badge variant="outline" className={`text-[10px] ${statusClassName(status)}`}>
      {STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

/**
 * Ticket status-update confirm card.
 *
 * Shows the ticket title and the status transition (from → to) as colored
 * badges.  Asks the user to confirm or reject the `tickets.update_status`
 * proposal.
 */
export function TicketStatusUpdateCard({
  descriptor,
  proposal,
  proposalBusyId,
  onConfirmProposal,
  onRejectProposal,
  onApplyViewIntent,
  onOpenResource,
}: AgentCardProps) {
  const title = pickTicketTitle(descriptor.props, proposal?.summary, proposal?.displayProps as Record<string, string | null> | undefined);
  const ticket = (descriptor.props.ticket ?? {}) as Record<string, unknown>;
  // CONFIRMED: authoritative status from execute output (`ticket.status`).
  // PENDING:  target status from flattened proposal.input (`status`).
  const toStatus =
    (typeof ticket.status === "string" ? ticket.status : undefined) ??
    (typeof descriptor.props.toStatus === "string" ? descriptor.props.toStatus : undefined) ??
    (typeof descriptor.props.status === "string" ? descriptor.props.status : undefined) ??
    ((proposal?.displayProps as Record<string, string | null> | undefined)?.toStatus ?? undefined);
  const fromStatus = pickFromStatus(descriptor.props, proposal?.summary, proposal?.displayProps as Record<string, string | null> | undefined);
  const ticketId =
    (typeof ticket.id === "string" ? ticket.id : undefined)
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
          <div className="text-sm font-medium">{title}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            当前状态
            {statusBadge(toStatus)}
          </div>
        </div>
      </div>
    );
    return (
      <CardShell title="工单状态已更新" state="saved">
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
      title="工单状态更新"
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
            确认更新
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
          className="flex w-full items-center justify-between gap-2 rounded-xl bg-muted/30 px-3 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          onClick={() => openEntityResource("ticket", ticketId, "打开工单详情", handlers)}
        >
          <div className="min-w-0 text-sm font-medium">{title}</div>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        </button>
      ) : (
        <div className="rounded-xl bg-muted/30 px-3 py-2 text-sm font-medium">{title}</div>
      )}

      <div className="mt-3">
        <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">状态变更</div>
        <div className="flex items-center gap-2">
          {fromStatus ? (
            <>
              {statusBadge(fromStatus)}
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              {statusBadge(toStatus)}
            </>
          ) : (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              更新为
              {statusBadge(toStatus)}
            </div>
          )}
        </div>
      </div>
    </CardShell>
  );
}
