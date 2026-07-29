"use client";

import { useState } from "react";
import { Check, X, Loader2, FolderKanban, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";
import { openEntityResource } from "./open-resource";

const PROJECT_TYPE_LABEL: Record<string, string> = {
  RESEARCH: "科研",
  SERVICE: "服务",
  PRODUCT: "产品",
  CONSULTING: "咨询",
  OTHER: "其他",
};

function formatYuanRaw(yuan: number | undefined | null): string {
  if (yuan == null || Number.isNaN(Number(yuan))) return "¥0.00";
  return `¥${Number(yuan).toFixed(2)}`;
}

function formatDate(value?: string | null): string {
  if (!value) return "未填写";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未填写";
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function pickCustomerName(props: Record<string, unknown>, summary?: string, displayProps?: Record<string, string | null>): string {
  const direct = typeof props.customerName === "string" ? props.customerName.trim() : "";
  if (direct) return direct;
  if (displayProps?.customerName) return displayProps.customerName.trim();
  if (typeof summary === "string") {
    // projects.create summary: 将创建项目「<name>」，客户为「<customer>」…
    const m = summary.match(/客户为「(.+?)」/);
    if (m && m[1]) return m[1].trim();
  }
  return "客户";
}

/**
 * Project create-draft confirm card.
 *
 * Previews a project (name, type, customer, dates, budget) and asks the user
 * to confirm or reject the `projects.create` proposal.
 */
export function ProjectCreateDraftCard({
  descriptor,
  proposal,
  proposalBusyId,
  onConfirmProposal,
  onRejectProposal,
  onApplyViewIntent,
  onOpenResource,
}: AgentCardProps) {
  const isSaved = descriptor.state === "saved";
  // CONFIRMED: nested `project` (output: { id, name, projectNo, status }).
  // PENDING:  flattened proposal.input fields (name, projectType, budgetAmount 元, …).
  const project = (descriptor.props.project ?? {}) as Record<string, unknown>;
  const name =
    (typeof project.name === "string" && project.name.trim()) ||
    (typeof descriptor.props.name === "string" && descriptor.props.name.trim()) ||
    "新建项目";
  const projectType =
    (typeof project.projectType === "string" ? project.projectType : undefined) ??
    (typeof descriptor.props.projectType === "string" ? descriptor.props.projectType : undefined);
  const customerName = pickCustomerName(descriptor.props, proposal?.summary, proposal?.displayProps as Record<string, string | null> | undefined);
  const startDate = descriptor.props.startDate as string | undefined;
  const endDate = descriptor.props.endDate as string | undefined;
  // projects.create input: budgetAmount is in YUAN (parseInput passes through;
  // execute converts via yuanToCents). The card only shows budget on the
  // PENDING preview, so format as yuan (no ÷100).
  const budget = typeof descriptor.props.budgetAmount === "number"
    ? descriptor.props.budgetAmount
    : undefined;
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
    const projectNo = typeof project.projectNo === "string" ? project.projectNo : undefined;
    const projectId = typeof project.id === "string" ? project.id : undefined;
    const summary = (
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100">
          <Check className="h-5 w-5 text-emerald-600" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium">{name}</div>
          <div className="text-[11px] text-muted-foreground">
            客户：{customerName}
            {projectNo ? ` · 编号 ${projectNo}` : ""}
          </div>
          {budget != null ? (
            <div className="text-[11px] text-muted-foreground">预算 {formatYuanRaw(budget)}</div>
          ) : null}
        </div>
      </div>
    );
    return (
      <CardShell title="项目已创建" state="saved">
        {projectId ? (
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 rounded-xl text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            onClick={() => openEntityResource("project", projectId, "打开项目详情", {
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
      title={`新建项目：${customerName}`}
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
      <div className="flex items-center gap-3 rounded-xl bg-muted/30 px-3 py-2">
        <FolderKanban className="h-5 w-5 text-muted-foreground" />
        <div className="min-w-0">
          <div className="text-sm font-medium">{name}</div>
          {projectType ? (
            <div className="text-[11px] text-muted-foreground">
              类型：{PROJECT_TYPE_LABEL[projectType] ?? projectType}
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-3 space-y-1.5 text-sm">
        <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/20 px-3 py-1.5">
          <span className="text-[11px] text-muted-foreground">客户</span>
          <span className="min-w-0 truncate">{customerName}</span>
        </div>
        <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/20 px-3 py-1.5">
          <span className="text-[11px] text-muted-foreground">开始日期</span>
          <span>{formatDate(startDate)}</span>
        </div>
        <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/20 px-3 py-1.5">
          <span className="text-[11px] text-muted-foreground">结束日期</span>
          <span>{formatDate(endDate)}</span>
        </div>
      </div>

      {budget != null ? (
        <div className="mt-3 flex items-center justify-between rounded-xl bg-emerald-50/70 px-3 py-2 text-sm">
          <span className="text-[11px] font-medium text-emerald-900">项目预算</span>
          <span className="font-semibold tabular-nums text-emerald-700">{formatYuanRaw(budget)}</span>
        </div>
      ) : null}
    </CardShell>
  );
}
