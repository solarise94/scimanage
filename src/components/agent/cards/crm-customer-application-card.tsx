"use client";

import { useState, useEffect } from "react";
import { Check, X, Loader2, AlertTriangle, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";
import { openEntityResource } from "./open-resource";

interface DuplicateCandidate {
  id: string;
  name: string;
  customerCodeLast6: string;
  organization: string | null;
  matchReasons: string[];
}

/**
 * Customer application draft card.
 *
 * For submitting new customer applications.  Supports duplicate confirmation
 * state: when blocking duplicates are detected, the card switches to a
 * confirmation mode requiring explicit "仍然新建" action.  The candidates are
 * read from the proposal's persisted input (set by buildProposal).
 *
 * The `duplicateDecision=CREATE_NEW` field is only set via PATCH after the
 * user explicitly checks the confirmation box - the model cannot set it.
 */
export function CrmCustomerApplicationCard({
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
  const name = descriptor.props.name as string;
  const isSaved = descriptor.state === "saved";
  const isTerminal = isSaved || descriptor.state === "cancelled";
  const handlers = { onOpenResource, onApplyViewIntent };
  // Read duplicate candidates from proposal input (set by buildProposal)
  const proposalInput = proposal?.input as Record<string, unknown> | undefined;
  const duplicateCandidates = (proposalInput?.duplicateCandidates as DuplicateCandidate[]) ?? [];
  const requiresOverride = proposalInput?.requiresDuplicateOverride === true;
  const alreadyOverridden = proposalInput?.duplicateDecision === "CREATE_NEW";

  const [confirmCreate, setConfirmCreate] = useState(alreadyOverridden);
  const [saving, setSaving] = useState(false);

  // Track dirty state: the override checkbox is unsaved local state
  useEffect(() => {
    if (isTerminal) {
      onCardDirtyChange?.(false);
      return;
    }
    onCardDirtyChange?.(requiresOverride && !alreadyOverridden && confirmCreate);
    return () => onCardDirtyChange?.(false);
  }, [confirmCreate, requiresOverride, alreadyOverridden, isTerminal, onCardDirtyChange]);

  async function handleSubmit() {
    if (!proposal) return;
    setSaving(true);
    try {
      if (requiresOverride && !alreadyOverridden && confirmCreate) {
        // User confirmed override - PATCH the proposal to set CREATE_NEW
        await onUpdateProposal(proposal.id, {
          ...(proposal.input as Record<string, unknown>),
          duplicateDecision: "CREATE_NEW",
        });
      }
      await onConfirmProposal(proposal.id);
    } catch {
      // Error handled by parent
    } finally {
      setSaving(false);
    }
  }

  if (isSaved) {
    const app = descriptor.props.application as
      | { id: string; status: string; supervisorReviewStatus: string }
      | undefined;
    const profileId = descriptor.props.profileId as string;
    return (
      <CardShell title="客户申请已提交" state="saved">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100">
            <Check className="h-5 w-5 text-emerald-600" />
          </div>
          <div className="min-w-0">
            {profileId ? (
              <button
                type="button"
                className="inline-flex max-w-full items-center gap-1 text-left text-sm font-medium hover:underline focus-visible:outline-none"
                onClick={() => openEntityResource("customer", profileId, "打开客户详情", handlers)}
              >
                <span className="truncate">{name}</span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
              </button>
            ) : (
              <div className="text-sm font-medium">{name}</div>
            )}
            <div className="text-[11px] text-muted-foreground">
              档案编号：{profileId?.slice(-8) || "-"}
            </div>
            {app?.supervisorReviewStatus ? (
              <div className="text-[11px] text-muted-foreground">
                主管复核：{app.supervisorReviewStatus === "PENDING" ? "待复核" : app.supervisorReviewStatus}
              </div>
            ) : null}
          </div>
        </div>
      </CardShell>
    );
  }

  const canSubmit = !requiresOverride || alreadyOverridden || confirmCreate;

  return (
    <CardShell
      title={`新增客户：${name}`}
      state={descriptor.state}
      footer={
        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1"
            disabled={!canSubmit || saving || proposalBusyId === proposal?.id}
            onClick={handleSubmit}
          >
            {saving || proposalBusyId === proposal?.id ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            {requiresOverride && !alreadyOverridden ? "确认仍然新建" : "提交申请"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={saving || proposalBusyId === proposal?.id}
            onClick={() => proposal && onRejectProposal(proposal.id)}
          >
            <X className="h-4 w-4" />
            取消
          </Button>
        </div>
      }
    >
      {requiresOverride && !alreadyOverridden ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 rounded-lg border border-amber-200/80 bg-amber-50/80 px-3 py-2 text-[11px] text-amber-950">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            检测到可能重复的客户，请确认是否仍然新建
          </div>
          {duplicateCandidates.map((c) => (
            <button
              key={c.id}
              type="button"
              className="flex w-full items-center justify-between gap-2 rounded-lg border border-border/40 bg-background/60 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              onClick={() => openEntityResource("customer", c.id, "打开客户详情", handlers)}
            >
              <div className="min-w-0">
                <div className="font-medium">{c.name}</div>
                <div className="text-[11px] text-muted-foreground">
                  {c.organization || "无机构"}
                  {c.customerCodeLast6 ? ` · #${c.customerCodeLast6}` : ""}
                </div>
                {c.matchReasons?.length > 0 ? (
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    匹配原因：{c.matchReasons.join("、")}
                  </div>
                ) : null}
              </div>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
            </button>
          ))}
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={confirmCreate}
              onChange={(e) => setConfirmCreate(e.target.checked)}
              className="h-4 w-4"
            />
            我确认要仍然新建此客户
          </label>
        </div>
      ) : requiresOverride && alreadyOverridden ? (
        <div className="rounded-lg border border-amber-200/80 bg-amber-50/80 px-3 py-2 text-[11px] text-amber-950">
          <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
          已确认仍然新建（重复覆盖）
        </div>
      ) : (
        <div className="text-[11px] text-muted-foreground">
          提交后将创建客户档案并进入主管复核队列。
        </div>
      )}
    </CardShell>
  );
}
