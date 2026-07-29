"use client";

import { useState } from "react";
import { Check, X, Loader2, Building2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";

/**
 * Organization binding request card.
 *
 * Shows the organization binding request status.  For existing orgs, displays
 * warnings about conflicts without leaking other reps' privacy.  For new orgs,
 * shows that a review task will be created.
 */
export function CrmOrganizationRequestCard({
  descriptor,
  proposal,
  proposalBusyId,
  onConfirmProposal,
  onRejectProposal,
}: AgentCardProps) {
  const organizationName = descriptor.props.organizationName as string;
  const isNewOrg = descriptor.props.isNewOrg === "true";
  const warnings = (descriptor.props.warnings as string[]) ?? [];
  const isSaved = descriptor.state === "saved";
  const [saving, setSaving] = useState(false);

  const warningLabels: Record<string, string> = {
    ORG_BOUND_BY_OTHER_REP: "该单位已被其他代表绑定",
    ORG_PENDING_BY_OTHER_REP: "该单位有其他代表正在申请绑定",
    ORG_NAME_PENDING_BY_OTHER_REP: "该单位名称有其他代表正在提报",
  };

  async function handleSubmit() {
    if (!proposal) return;
    setSaving(true);
    try {
      await onConfirmProposal(proposal.id);
    } finally {
      setSaving(false);
    }
  }

  if (isSaved) {
    const status = descriptor.props.status as string;
    return (
      <CardShell title="单位申请已提交" state="saved">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100">
            <Check className="h-5 w-5 text-emerald-600" />
          </div>
          <div>
            <div className="text-sm font-medium">{organizationName}</div>
            <div className="text-[11px] text-muted-foreground">
              状态：{status === "PENDING" ? "等待审核" : status}
            </div>
          </div>
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell
      title={isNewOrg ? "提报新单位" : "申请绑定单位"}
      state={descriptor.state}
      footer={
        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1"
            disabled={saving || proposalBusyId === proposal?.id}
            onClick={handleSubmit}
          >
            {saving || proposalBusyId === proposal?.id ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            提交申请
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
      <div className="flex items-center gap-3 rounded-xl bg-muted/30 px-3 py-2">
        <Building2 className="h-5 w-5 text-muted-foreground" />
        <div>
          <div className="text-sm font-medium">{organizationName}</div>
          {isNewOrg ? (
            <div className="text-[11px] text-muted-foreground">新单位（将创建审核任务）</div>
          ) : null}
        </div>
      </div>

      {warnings.length > 0 ? (
        <div className="mt-2 space-y-1">
          {warnings.map((w) => (
            <div
              key={w}
              className="flex items-center gap-2 rounded-lg border border-amber-200/80 bg-amber-50/80 px-2.5 py-1.5 text-[11px] text-amber-950"
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {warningLabels[w] || w}
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-2 text-[11px] text-muted-foreground">
        提交后状态为 PENDING，等待管理员审核。
      </div>
    </CardShell>
  );
}
