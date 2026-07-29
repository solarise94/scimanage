"use client";

import { useState, useEffect } from "react";
import { Check, X, Loader2, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";
import { openEntityResource } from "./open-resource";

const TYPE_LABELS: Record<string, string> = {
  CALL: "电话", WECHAT: "微信", EMAIL: "邮件", MEETING: "会议",
  VISIT: "拜访", REFERRAL: "转介绍", NOTE: "备注",
};

/**
 * CRM interaction draft card.
 *
 * For creating communication/visit records.  Distinguishes "拜访记录" (no
 * location required) from "现场签到" (requires evidence).
 */
export function CrmInteractionDraftCard({
  descriptor,
  proposal,
  proposalBusyId,
  onConfirmProposal,
  onRejectProposal,
  onUpdateProposal,
  onCardDirtyChange,
  onApplyViewIntent,
  onOpenResource,
}: AgentCardProps) {
  const profileId =
    (typeof descriptor.props.profileId === "string" && descriptor.props.profileId)
    || (typeof (proposal?.input as Record<string, unknown> | undefined)?.profileId === "string"
      ? ((proposal?.input as Record<string, unknown>).profileId as string)
      : undefined);
  const customerName =
    (typeof descriptor.props.customerName === "string" && descriptor.props.customerName.trim())
      || ((proposal?.displayProps as Record<string, string | null> | undefined)?.customerName ?? undefined)
      || (typeof proposal?.summary === "string" && proposal.summary.match(/客户「(.+?)」/)?.[1])
      || "客户";
  const type = descriptor.props.type as string;
  const isSaved = descriptor.state === "saved";
  const isTerminal = isSaved || descriptor.state === "cancelled";
  const handlers = { onOpenResource, onApplyViewIntent };
  const [summary, setSummary] = useState((descriptor.props.summary as string) || "");
  const [detail, setDetail] = useState((descriptor.props.detail as string) || "");
  const [saving, setSaving] = useState(false);

  // Track dirty state for session-switch protection
  useEffect(() => {
    if (isTerminal) {
      onCardDirtyChange?.(false);
      return;
    }
    onCardDirtyChange?.(summary.trim().length > 0 || detail.trim().length > 0);
    return () => onCardDirtyChange?.(false);
  }, [summary, detail, isTerminal, onCardDirtyChange]);

  async function handleSave() {
    if (!proposal || !summary.trim()) return;
    setSaving(true);
    try {
      const currentInput = proposal.input as Record<string, unknown>;
      await onUpdateProposal(proposal.id, {
        ...currentInput,
        summary: summary.trim(),
        detail: detail.trim() || undefined,
      });
      await onConfirmProposal(proposal.id);
    } catch {
      // Error handled by parent
    } finally {
      setSaving(false);
    }
  }

  if (isSaved) {
    return (
      <CardShell title="沟通记录已保存" state="saved">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100">
            <Check className="h-5 w-5 text-emerald-600" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium">
              {TYPE_LABELS[type] ?? type} ·{" "}
              {profileId ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-0.5 hover:underline focus-visible:outline-none"
                  onClick={() => openEntityResource("customer", profileId, "打开客户详情", handlers)}
                >
                  {customerName}
                  <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
                </button>
              ) : (
                customerName
              )}
            </div>
            <div className="text-[11px] text-muted-foreground">{summary}</div>
          </div>
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell
      title={`${TYPE_LABELS[type] ?? "沟通"}记录：${customerName}`}
      state={descriptor.state}
      footer={
        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1 rounded-full"
            disabled={!summary.trim() || saving || proposalBusyId === proposal?.id}
            onClick={handleSave}
          >
            {saving || proposalBusyId === proposal?.id ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            保存
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1 rounded-full border-border/50 bg-card shadow-none"
            disabled={saving || proposalBusyId === proposal?.id}
            onClick={() => proposal && onRejectProposal(proposal.id)}
          >
            <X className="h-4 w-4" />
            取消
          </Button>
        </div>
      }
    >
      {type === "VISIT" ? (
        <div className="mb-3 rounded-lg border border-amber-200/60 bg-amber-50/70 px-3 py-2 text-[11px] leading-5 text-amber-950">
          拜访记录：记录已发生的拜访，不要求定位证据。如需现场签到，请使用&ldquo;现场签到&rdquo;功能。
        </div>
      ) : null}
      {profileId ? (
        <button
          type="button"
          className="mb-3 flex w-full items-center justify-between gap-2 rounded-lg bg-muted/30 px-3 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          onClick={() => openEntityResource("customer", profileId, "打开客户详情", handlers)}
        >
          <div className="min-w-0">
            <div className="text-[11px] text-muted-foreground">客户</div>
            <div className="truncate text-sm font-medium">{customerName}</div>
          </div>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        </button>
      ) : null}
      <div className="space-y-3">
        <div>
          <label className="text-[11px] font-medium text-muted-foreground">摘要</label>
          <Textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="沟通摘要（必填）"
            rows={2}
            className="mt-1 resize-none rounded-lg border-border/50 bg-muted/20 text-sm shadow-none"
          />
        </div>
        <div>
          <label className="text-[11px] font-medium text-muted-foreground">详情（可选）</label>
          <Textarea
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder="补充详情"
            rows={3}
            className="mt-1 resize-none rounded-lg border-border/50 bg-muted/20 text-sm shadow-none"
          />
        </div>
      </div>
    </CardShell>
  );
}
