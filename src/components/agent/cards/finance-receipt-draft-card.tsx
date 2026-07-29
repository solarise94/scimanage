"use client";

import { useState } from "react";
import { Check, X, Loader2, Banknote, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";

function formatYuan(cents: number | undefined | null): string {
  if (cents == null || Number.isNaN(Number(cents))) return "¥0.00";
  return `¥${(Number(cents) / 100).toFixed(2)}`;
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

function pickOrganizationName(props: Record<string, unknown>, summary?: string, displayProps?: Record<string, string | null>): string {
  const direct = typeof props.organizationName === "string" ? props.organizationName.trim() : "";
  if (direct) return direct;
  if (displayProps?.organizationName) return displayProps.organizationName.trim();
  if (typeof summary === "string") {
    // finance.create_receipt summary: 将为「<org name>」创建回款记录 …
    const m = summary.match(/「(.+?)」/);
    if (m && m[1]) return m[1].trim();
  }
  return "未知单位";
}

/**
 * Finance receipt draft confirm card.
 *
 * Previews a receipt (organization, amount, allocation count, received date)
 * and asks the user to confirm or reject the `finance.create_receipt`
 * proposal.
 */
export function FinanceReceiptDraftCard({
  descriptor,
  proposal,
  proposalBusyId,
  onConfirmProposal,
  onRejectProposal,
}: AgentCardProps) {
  const isSaved = descriptor.state === "saved";
  // CONFIRMED: data comes from execute output `receipt` object.
  // PENDING:  data comes from proposal.input (flattened by extractProps) — uses
  // `amountCents` / `allocations[].amountCents` (post-parseInput shape).
  const receipt = (descriptor.props.receipt ?? {}) as Record<string, unknown>;
  const organizationName = pickOrganizationName(descriptor.props, proposal?.summary, proposal?.displayProps as Record<string, string | null> | undefined);
  const amount = (typeof receipt.amount === "number"
    ? receipt.amount
    : typeof descriptor.props.amountCents === "number"
      ? descriptor.props.amountCents
      : undefined) as number | undefined;
  const allocations = Array.isArray(descriptor.props.allocations)
    ? descriptor.props.allocations
    : [];
  const allocationCount =
    (typeof descriptor.props.allocationCount === "number"
      ? descriptor.props.allocationCount
      : undefined) ?? allocations.length;
  const receivedAt = (typeof receipt.receivedAt === "string"
    ? receipt.receivedAt
    : typeof descriptor.props.receivedAt === "string"
      ? descriptor.props.receivedAt
      : undefined) as string | undefined;
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
    const receiptNo =
      (typeof receipt.id === "string" ? receipt.id : undefined) ??
      (typeof descriptor.props.receiptNo === "string" ? descriptor.props.receiptNo : undefined);
    return (
      <CardShell title="收款已创建" state="saved">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100">
            <Check className="h-5 w-5 text-emerald-600" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium">{organizationName}</div>
            <div className="text-[11px] text-muted-foreground">
              金额 {formatYuan(amount)}
              {receiptNo ? ` · 编号 ${receiptNo}` : ""}
            </div>
          </div>
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell
      title="新建收款"
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
        <Banknote className="h-5 w-5 text-muted-foreground" />
        <div className="min-w-0">
          <div className="text-sm font-medium">{organizationName}</div>
          <div className="text-[11px] text-muted-foreground">收款到账日期：{formatDate(receivedAt)}</div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between rounded-xl bg-emerald-50/70 px-3 py-2 text-sm">
        <span className="text-[11px] font-medium text-emerald-900">收款金额</span>
        <span className="font-semibold tabular-nums text-emerald-700">{formatYuan(amount)}</span>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-muted/20 px-3 py-1.5 text-sm">
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Layers className="h-3.5 w-3.5" />
          核销分配
        </span>
        <span>{allocationCount} 笔</span>
      </div>
    </CardShell>
  );
}
