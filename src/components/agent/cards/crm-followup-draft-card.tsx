"use client";

import { useState, useMemo, useEffect } from "react";
import { Check, X, Loader2, Bell, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";
import { openEntityResource } from "./open-resource";

/**
 * Follow-up task draft card.
 *
 * The owner is always the current representative - no owner selector shown.
 */
export function CrmFollowUpDraftCard({
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
  const customerName = descriptor.props.customerName as string;
  const profileId =
    (typeof descriptor.props.profileId === "string" && descriptor.props.profileId)
    || (typeof (proposal?.input as Record<string, unknown> | undefined)?.profileId === "string"
      ? ((proposal?.input as Record<string, unknown>).profileId as string)
      : undefined);
  const isSaved = descriptor.state === "saved";
  const isTerminal = isSaved || descriptor.state === "cancelled";
  const handlers = { onOpenResource, onApplyViewIntent };
  const [title, setTitle] = useState((descriptor.props.title as string) || "");
  // Initialize dueAt with the existing value or a default of tomorrow 10:00
  const [saving, setSaving] = useState(false);

  // Track dirty state for session-switch protection
  useEffect(() => {
    if (isTerminal) {
      onCardDirtyChange?.(false);
      return;
    }
    onCardDirtyChange?.(title.trim().length > 0);
    return () => onCardDirtyChange?.(false);
  }, [title, isTerminal, onCardDirtyChange]);

  // Compute default due date once (local time, tomorrow 10:00)
  const defaultDueAtLocal = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
    // Format as YYYY-MM-DDTHH:mm in LOCAL time (not UTC) for datetime-local input
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }, []);

  const [dueAt, setDueAt] = useState((descriptor.props.dueAt as string) || defaultDueAtLocal);

  async function handleSave() {
    if (!proposal || !title.trim() || !dueAt) return;
    setSaving(true);
    try {
      const currentInput = proposal.input as Record<string, unknown>;
      await onUpdateProposal(proposal.id, {
        ...currentInput,
        title: title.trim(),
        dueAt: new Date(dueAt).toISOString(),
      });
      await onConfirmProposal(proposal.id);
    } catch {
      // Error handled by parent
    } finally {
      setSaving(false);
    }
  }

  if (isSaved) {
    const task = descriptor.props.task as
      | { id: string; title: string; status: string; dueAt: string }
      | undefined;
    return (
      <CardShell title="跟进任务已创建" state="saved">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100">
            <Check className="h-5 w-5 text-emerald-600" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium">{task?.title || title}</div>
            <div className="text-[11px] text-muted-foreground">
              客户：
              {profileId ? (
                <button
                  type="button"
                  className="ml-0.5 inline-flex items-center gap-0.5 hover:underline focus-visible:outline-none"
                  onClick={() => openEntityResource("customer", profileId, "打开客户详情", handlers)}
                >
                  {customerName}
                  <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
                </button>
              ) : (
                customerName
              )}
              {task?.dueAt ? ` · 截止 ${new Date(task.dueAt).toLocaleDateString("zh-CN")}` : ""}
            </div>
          </div>
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell
      title={`跟进任务：${customerName}`}
      state={descriptor.state}
      footer={
        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1"
            disabled={!title.trim() || !dueAt || saving || proposalBusyId === proposal?.id}
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
            disabled={saving || proposalBusyId === proposal?.id}
            onClick={() => proposal && onRejectProposal(proposal.id)}
          >
            <X className="h-4 w-4" />
            取消
          </Button>
        </div>
      }
    >
      <div className="space-y-2">
        {profileId ? (
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 rounded-xl bg-muted/30 px-3 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            onClick={() => openEntityResource("customer", profileId, "打开客户详情", handlers)}
          >
            <div className="min-w-0">
              <div className="text-[11px] text-muted-foreground">客户</div>
              <div className="truncate text-sm font-medium">{customerName}</div>
            </div>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
          </button>
        ) : null}
        <div className="flex items-center gap-2 rounded-xl bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          <Bell className="h-3.5 w-3.5" />
          负责人：当前用户（代表）
        </div>
        <div>
          <label className="text-[11px] font-medium text-muted-foreground">任务标题</label>
          <Textarea
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="跟进任务标题"
            rows={2}
            className="mt-1 resize-none text-sm"
          />
        </div>
        <div>
          <label className="text-[11px] font-medium text-muted-foreground">截止时间</label>
          <input
            type="datetime-local"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
            className="mt-1 flex h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
          />
        </div>
      </div>
    </CardShell>
  );
}
