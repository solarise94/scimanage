"use client";

import { useState } from "react";
import { Check, X, Loader2, FileSignature, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";

function formatYuan(cents: number | undefined | null): string {
  if (cents == null || Number.isNaN(Number(cents))) return "¥0.00";
  return `¥${(Number(cents) / 100).toFixed(2)}`;
}

function readDisplayProps(proposal: AgentCardProps["proposal"]) {
  return (proposal?.displayProps ?? {}) as Record<string, string | null>;
}

/**
 * Generate confirm card for `contracts.generate`.
 */
export function ContractsGenerateConfirmCard({
  descriptor,
  proposal,
  proposalBusyId,
  onConfirmProposal,
  onRejectProposal,
}: AgentCardProps) {
  const isSaved = descriptor.state === "saved";
  const props = descriptor.props;
  const displayProps = readDisplayProps(proposal);

  const contractNo =
    typeof props.contractNo === "string"
      ? props.contractNo
      : displayProps.contractNo || null;
  const templateName = displayProps.templateName || displayProps.template || null;
  const buyerName = displayProps.buyerName || displayProps.buyerOrgName || null;
  const sellerName = displayProps.sellerName || null;
  const totalAmount =
    typeof props.totalAmountCents === "number"
      ? formatYuan(props.totalAmountCents)
      : displayProps.totalAmount || null;
  const coveredOrderCount =
    typeof props.coveredOrderCount === "number"
      ? props.coveredOrderCount
      : displayProps.coveredOrderCount
        ? Number(displayProps.coveredOrderCount)
        : null;
  const downloadUrl = typeof props.downloadUrl === "string" ? props.downloadUrl : null;

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
    return (
      <CardShell title="合同已生成" state="saved">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100">
            <Check className="h-5 w-5 text-emerald-600" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium">{contractNo || "合同生成成功"}</div>
            <div className="text-[11px] text-muted-foreground">
              {totalAmount ? `金额 ${totalAmount}` : null}
              {coveredOrderCount != null ? ` · 覆盖 ${coveredOrderCount} 笔订单` : null}
            </div>
            {downloadUrl ? (
              <div className="mt-1 text-[11px] text-sky-700">可下载：{downloadUrl}</div>
            ) : null}
          </div>
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell
      title="确认生成合同"
      state={descriptor.state}
      footer={
        proposal ? (
          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1"
              disabled={saving || proposalBusyId === proposal.id}
              onClick={handleConfirm}
            >
              {saving || proposalBusyId === proposal.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              确认生成
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={saving || proposalBusyId === proposal.id}
              onClick={() => onRejectProposal(proposal.id)}
            >
              <X className="h-4 w-4" />
              拒绝
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="flex items-start gap-2 rounded-xl bg-muted/30 px-3 py-2">
        <FileSignature className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{templateName || "合同生成"}</div>
          {proposal?.summary ? (
            <div className="text-[11px] text-muted-foreground">{proposal.summary}</div>
          ) : null}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        {sellerName ? (
          <div className="rounded-lg bg-muted/20 px-2.5 py-2">
            <div className="mb-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
              <Building2 className="h-3 w-3" />
              卖方
            </div>
            <div className="font-medium">{sellerName}</div>
          </div>
        ) : null}
        {buyerName ? (
          <div className="rounded-lg bg-muted/20 px-2.5 py-2">
            <div className="mb-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
              <Building2 className="h-3 w-3" />
              买方
            </div>
            <div className="font-medium">{buyerName}</div>
          </div>
        ) : null}
      </div>

      {totalAmount ? (
        <div className="mt-3 flex items-center justify-between rounded-xl bg-emerald-50/70 px-3 py-2 text-sm">
          <span className="text-[11px] font-medium text-emerald-900">合同金额</span>
          <span className="font-semibold tabular-nums text-emerald-700">{totalAmount}</span>
        </div>
      ) : null}

      {coveredOrderCount != null ? (
        <div className="mt-2 text-[11px] text-muted-foreground">
          覆盖 {coveredOrderCount} 笔订单
        </div>
      ) : null}
    </CardShell>
  );
}
