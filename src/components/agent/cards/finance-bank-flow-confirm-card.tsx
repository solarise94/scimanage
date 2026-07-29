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

function parseAmountText(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  return trimmed || null;
}

/**
 * Confirm card for `finance.confirm_bank_flow_batch`.
 */
export function FinanceBankFlowConfirmCard({
  descriptor,
  proposal,
  proposalBusyId,
  onConfirmProposal,
  onRejectProposal,
}: AgentCardProps) {
  const isSaved = descriptor.state === "saved";
  const props = descriptor.props;
  const displayProps = (proposal?.displayProps ?? {}) as Record<string, string | null>;

  const rowCount =
    typeof props.created === "number"
      ? props.created
      : Number(displayProps.rowCount) || null;
  const totalAmount =
    typeof props.totalAmountCents === "number"
      ? formatYuan(props.totalAmountCents)
      : parseAmountText(displayProps.totalAmount);
  const failed = typeof props.failed === "number" ? props.failed : 0;
  const skipped = typeof props.skipped === "number" ? props.skipped : 0;

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
      <CardShell title="银行流水核销完成" state="saved">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100">
            <Check className="h-5 w-5 text-emerald-600" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium">
              已创建 {rowCount ?? 0} 笔回款
            </div>
            <div className="text-[11px] text-muted-foreground">
              合计 {totalAmount || formatYuan(props.totalAmountCents as number | undefined)}
              {failed > 0 ? ` · ${failed} 笔失败` : null}
              {skipped > 0 ? ` · ${skipped} 笔跳过` : null}
            </div>
          </div>
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell
      title="确认银行流水核销"
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
              确认核销
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
      <div className="flex items-center gap-3 rounded-xl bg-muted/30 px-3 py-2">
        <Banknote className="h-5 w-5 text-muted-foreground" />
        <div className="min-w-0">
          <div className="text-sm font-medium">
            待创建 {rowCount ?? "-"} 笔回款
          </div>
          {proposal?.summary ? (
            <div className="text-[11px] text-muted-foreground">{proposal.summary}</div>
          ) : null}
        </div>
      </div>

      {totalAmount ? (
        <div className="mt-3 flex items-center justify-between rounded-xl bg-emerald-50/70 px-3 py-2 text-sm">
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-900">
            <Layers className="h-3.5 w-3.5" />
            合计金额
          </span>
          <span className="font-semibold tabular-nums text-emerald-700">{totalAmount}</span>
        </div>
      ) : null}
    </CardShell>
  );
}
