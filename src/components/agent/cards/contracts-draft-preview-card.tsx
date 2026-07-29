"use client";

import { useState } from "react";
import { AlertCircle, FileSignature, Building2, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";

function formatYuan(cents: number | undefined | null): string {
  if (cents == null || Number.isNaN(Number(cents))) return "¥0.00";
  return `¥${(Number(cents) / 100).toFixed(2)}`;
}

function readDraft(props: Record<string, unknown>) {
  const draft = (props.draft ?? {}) as Record<string, unknown>;
  const template = (draft.template ?? {}) as Record<string, unknown>;
  const sellerProfile = (draft.sellerProfile ?? {}) as Record<string, unknown>;
  const buyerFields = (draft.buyerFields ?? {}) as Record<string, unknown>;
  return { draft, template, sellerProfile, buyerFields };
}

/**
 * Draft preview card for `contracts.prepare_draft`.
 *
 * P0-4：prepare_contract facade 已用 generationIntentId 产 contracts.generate 的
 * PENDING proposal；本卡片复用现有 proposal confirm 链路（参照 crm-checkin-draft-card），
 * 加「确认生成」按钮，点击 → onConfirmProposal(proposal.id)。无 proposal 句柄时回退为
 * onCreateProposal("contracts.generate", ...) 自建（兼容旧调用方）。
 */
export function ContractsDraftPreviewCard({
  descriptor,
  proposal,
  proposalBusyId,
  onConfirmProposal,
  onCreateProposal,
}: AgentCardProps) {
  const props = descriptor.props;
  const { draft, template, sellerProfile, buyerFields } = readDraft(props);

  const templateName = typeof template.name === "string" ? template.name : "未指定模板";
  const sellerName =
    typeof sellerProfile.companyName === "string"
      ? sellerProfile.companyName
      : typeof sellerProfile.name === "string"
        ? sellerProfile.name
        : "待定卖方";
  const buyerName =
    typeof buyerFields.buyerOrgName === "string"
      ? buyerFields.buyerOrgName
      : typeof buyerFields.buyerName === "string"
        ? buyerFields.buyerName
        : "待定买方";
  const totalAmountCents =
    typeof draft.totalAmountCents === "number"
      ? draft.totalAmountCents
      : typeof draft.totalAmount === "number"
        ? draft.totalAmount
        : undefined;
  const totalAmountInWords =
    typeof draft.totalAmountInWords === "string" ? draft.totalAmountInWords : null;
  const lineCount = typeof draft.lineCount === "number" ? draft.lineCount : null;
  const warnings = Array.isArray(draft.warnings)
    ? (draft.warnings as unknown[]).filter((w): w is string => typeof w === "string")
    : [];

  // P0-4：proposal 句柄优先来自 facade（preview_then_confirm_generate 链路已产 PENDING）。
  const proposalId = proposal?.id ?? null;
  const [creating, setCreating] = useState(false);
  const busy = creating || (proposalId ? proposalBusyId === proposalId : false);

  async function handleConfirm() {
    if (proposalId) {
      await onConfirmProposal(proposalId);
      return;
    }
    // 回退：facade 未产 proposal 时由卡片自建（需 generationIntentId 等输入齐备）。
    if (!onCreateProposal) return;
    const generationIntentId =
      typeof draft.generationIntentId === "string" ? draft.generationIntentId : "";
    const templateId = typeof template.id === "string" ? template.id : "";
    const sellerProfileId = typeof sellerProfile.id === "string" ? sellerProfile.id : "";
    const orderIdsRaw = Array.isArray(draft.coveredOrders)
      ? (draft.coveredOrders as Array<Record<string, unknown>>)
          .map((o) => o.orderId)
          .filter((id): id is string => typeof id === "string")
      : [];
    if (!generationIntentId || !templateId || !sellerProfileId || orderIdsRaw.length === 0) return;
    setCreating(true);
    try {
      const created = await onCreateProposal("contracts.generate", {
        generationIntentId,
        orderIds: orderIdsRaw,
        templateId,
        sellerProfileId,
      });
      if (created) {
        await onConfirmProposal(created.id);
      }
    } catch {
      // 错误由父级处理（toast）
    } finally {
      setCreating(false);
    }
  }

  return (
    <CardShell
      title="合同草稿预览"
      state={descriptor.state}
      footer={
        <Button
          size="sm"
          className="w-full"
          disabled={busy || !onConfirmProposal}
          onClick={handleConfirm}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          确认生成
        </Button>
      }
    >
      <div className="flex items-start gap-2 rounded-xl bg-muted/30 px-3 py-2">
        <FileSignature className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{templateName}</div>
          {lineCount != null ? (
            <div className="text-[11px] text-muted-foreground">覆盖 {lineCount} 笔订单</div>
          ) : null}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg bg-muted/20 px-2.5 py-2">
          <div className="mb-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
            <Building2 className="h-3 w-3" />
            卖方
          </div>
          <div className="font-medium">{sellerName}</div>
        </div>
        <div className="rounded-lg bg-muted/20 px-2.5 py-2">
          <div className="mb-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
            <Building2 className="h-3 w-3" />
            买方
          </div>
          <div className="font-medium">{buyerName}</div>
        </div>
      </div>

      <div className="mt-3 rounded-xl bg-emerald-50/70 px-3 py-2">
        <div className="text-[11px] font-medium text-emerald-900">合同金额</div>
        <div className="text-lg font-semibold tabular-nums text-emerald-700">
          {formatYuan(totalAmountCents)}
        </div>
        {totalAmountInWords ? (
          <div className="mt-0.5 text-[11px] text-emerald-800/80">{totalAmountInWords}</div>
        ) : null}
      </div>

      {warnings.length > 0 ? (
        <div className="mt-3 space-y-1">
          {warnings.map((w, i) => (
            <div
              key={i}
              className="flex items-start gap-1.5 rounded-lg bg-amber-50/70 px-2.5 py-1.5 text-[11px] text-amber-950"
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      ) : null}
    </CardShell>
  );
}
