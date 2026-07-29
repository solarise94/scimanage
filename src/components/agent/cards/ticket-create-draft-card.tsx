"use client";

import { useState } from "react";
import { Check, X, Loader2, Ticket, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";
import { openEntityResource } from "./open-resource";

const PRIORITY_LABEL: Record<string, string> = {
  URGENT: "紧急",
  HIGH: "高",
  MEDIUM: "中",
  LOW: "低",
};

function priorityClassName(priority?: string): string {
  switch (priority) {
    case "URGENT":
      return "bg-rose-50 text-rose-700 border-rose-200";
    case "HIGH":
      return "bg-amber-50 text-amber-700 border-amber-200";
    case "MEDIUM":
      return "bg-blue-50 text-blue-700 border-blue-200";
    case "LOW":
    default:
      return "bg-muted/60 text-muted-foreground border-border/60";
  }
}

function pickProjectName(props: Record<string, unknown>, summary?: string, displayProps?: Record<string, string | null>): string {
  const direct = typeof props.projectName === "string" ? props.projectName.trim() : "";
  if (direct) return direct;
  if (displayProps?.projectName) return displayProps.projectName.trim();
  if (typeof summary === "string") {
    // tickets.create_from_text summary: 将在项目「<name>」下创建工单「<title>」…
    const m = summary.match(/项目「(.+?)」/);
    if (m && m[1]) return m[1].trim();
  }
  return "未关联项目";
}

/**
 * Ticket create-draft confirm card.
 *
 * Previews a ticket created from free text (title, project, priority,
 * description preview) and asks the user to confirm or reject the
 * `tickets.create_from_text` proposal.
 */
export function TicketCreateDraftCard({
  descriptor,
  proposal,
  proposalBusyId,
  onConfirmProposal,
  onRejectProposal,
  onApplyViewIntent,
  onOpenResource,
}: AgentCardProps) {
  const isSaved = descriptor.state === "saved";
  // CONFIRMED: nested `ticket` (output: { id, projectId, title, status, priority }).
  // PENDING:  flattened proposal.input ({ projectId, title, description, priority, … }).
  const ticket = (descriptor.props.ticket ?? {}) as Record<string, unknown>;
  const title =
    (typeof ticket.title === "string" && ticket.title.trim()) ||
    (typeof descriptor.props.title === "string" && descriptor.props.title.trim()) ||
    "新建工单";
  const projectName = pickProjectName(descriptor.props, proposal?.summary, proposal?.displayProps as Record<string, string | null> | undefined);
  const priority =
    (typeof ticket.priority === "string" ? ticket.priority : undefined) ??
    (typeof descriptor.props.priority === "string" ? descriptor.props.priority : undefined);
  const description =
    (typeof descriptor.props.description === "string" && descriptor.props.description.trim()) || "";
  const [saving, setSaving] = useState(false);

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
    // tickets.create_from_text output has no ticketNo; fall back to ticket.id.
    const ticketId = typeof ticket.id === "string" ? ticket.id : undefined;
    const summary = (
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100">
          <Check className="h-5 w-5 text-emerald-600" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          <div className="text-[11px] text-muted-foreground">
            {projectName !== "未关联项目" ? `项目：${projectName}` : null}
            {ticketId ? ` · 编号 ${ticketId}` : ""}
          </div>
        </div>
      </div>
    );
    return (
      <CardShell title="工单已创建" state="saved">
        {ticketId ? (
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 rounded-xl text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            onClick={() => openEntityResource("ticket", ticketId, "打开工单详情", {
              onOpenResource,
              onApplyViewIntent,
            })}
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
      title="新建工单"
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
            确认创建
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
      <div className="flex items-start gap-3 rounded-xl bg-muted/30 px-3 py-2">
        <Ticket className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{title}</div>
          {priority ? (
            <div className="mt-1 flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">优先级</span>
              <Badge variant="outline" className={`text-[10px] ${priorityClassName(priority)}`}>
                {PRIORITY_LABEL[priority] ?? priority}
              </Badge>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-muted/20 px-3 py-1.5 text-sm">
        <span className="text-[11px] text-muted-foreground">所属项目</span>
        <span className="min-w-0 truncate">{projectName}</span>
      </div>

      {description ? (
        <div className="mt-2">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">描述预览</div>
          <div className="line-clamp-4 rounded-lg border border-border/40 bg-muted/15 px-3 py-2 text-xs leading-relaxed text-foreground">
            {description}
          </div>
        </div>
      ) : null}
    </CardShell>
  );
}
