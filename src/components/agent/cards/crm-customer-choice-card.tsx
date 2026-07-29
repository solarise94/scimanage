"use client";

import { useState } from "react";
import { Check, ChevronRight, MapPin, MessageSquare, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardShell } from "./card-shell";
import { cn } from "@/lib/utils";
import type { AgentCardProps } from "../agent-ui-types";

interface CustomerItem {
  profileId: string;
  customerName: string;
  organization?: string;
  customerCodeLast6?: string;
  ownerName?: string;
  /** 命中原因（来自 crm.resolve_customer_name，如“发音相同”）。可选，展示为 chip。 */
  reason?: string;
}

/**
 * CRM customer choice card.
 *
 * Shown when a search returns multiple candidates.  The user must explicitly
 * select one customer before any write operation can proceed.  After
 * selecting, action buttons appear:
 * - "查看详情": onSendPrefilled -> stays inside the Agent and asks the model
 *   to fetch the full profile via crm.get_customer_context.  The profileId is
 *   embedded in the message text so the model can use it directly without
 *   re-searching by name.
 * - "现场签到": onCreateProposal("crm.prepare_visit_checkin") -> safe action
 *   returns a result that renders the checkin-draft card.
 * - "添加沟通": onCreateProposal("crm.create_interaction") -> creates a
 *   proposal bound to the selected profileId with a placeholder summary that
 *   the user edits before confirming.
 *
 * Tapping a customer row applies the same "查看详情" action.  This card never
 * emits a ViewIntent and never navigates away from the Agent.
 */
export function CrmCustomerChoiceCard({ descriptor, onCreateProposal, onSendPrefilled }: AgentCardProps) {
  const items = ((descriptor.props.items as CustomerItem[]) ?? []).slice(0, 5);
  const [selected, setSelected] = useState<CustomerItem | null>(null);

  function handleViewDetail(item: CustomerItem) {
    if (!onSendPrefilled) return;
    onSendPrefilled(`帮我查询${item.customerName}的详细信息`, {
      verifiedCustomerProfileId: item.profileId,
    });
  }

  return (
    <CardShell title="请选择客户" state={descriptor.state}>
      <div className="divide-y divide-border/50 overflow-hidden border-y border-border/40 bg-card">
        {items.map((item) => {
          const isSelected = selected?.profileId === item.profileId;
          return (
            <button
              key={item.profileId}
              type="button"
              onClick={() => {
                setSelected(item);
                handleViewDetail(item);
              }}
              className={cn(
                "flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors",
                isSelected ? "bg-muted/40" : "hover:bg-muted/25",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">{item.customerName}</div>
                <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
                  {item.organization || "无机构"}
                  {item.customerCodeLast6 ? ` · #${item.customerCodeLast6}` : ""}
                </div>
                {item.reason ? (
                  <div className="mt-1 inline-flex max-w-full items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                    {item.reason}
                  </div>
                ) : null}
              </div>
              {isSelected ? (
                <Check className="h-4 w-4 shrink-0 text-foreground/70" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" />
              )}
            </button>
          );
        })}
      </div>

      {selected ? (
        <div className="mt-3 space-y-2">
          <div className="text-[11px] font-medium text-muted-foreground">选择操作</div>
          <div className="grid grid-cols-3 gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-auto flex-col items-center gap-1 rounded-lg border-border/50 bg-card py-2.5 shadow-none"
              onClick={() => handleViewDetail(selected)}
            >
              <Eye className="h-4 w-4" />
              <span className="text-[10px]">查看详情</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-auto flex-col items-center gap-1 rounded-lg border-border/50 bg-card py-2.5 shadow-none"
              onClick={() => {
                if (onCreateProposal) {
                  void onCreateProposal("crm.prepare_visit_checkin", {
                    profileId: selected.profileId,
                    customerName: selected.customerName,
                  });
                }
              }}
            >
              <MapPin className="h-4 w-4" />
              <span className="text-[10px]">现场签到</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-auto flex-col items-center gap-1 rounded-lg border-border/50 bg-card py-2.5 shadow-none"
              onClick={() => {
                // Create a proposal bound to the explicitly selected profileId.
                // summary is required by parseInput; use a placeholder that the
                // user can edit in the interaction draft card before confirming.
                // customerName is display-only for the draft card title.
                if (onCreateProposal) {
                  void onCreateProposal("crm.create_interaction", {
                    profileId: selected.profileId,
                    type: "VISIT",
                    summary: "（请填写沟通摘要）",
                    happenedAt: new Date().toISOString(),
                    customerName: selected.customerName,
                  });
                }
              }}
            >
              <MessageSquare className="h-4 w-4" />
              <span className="text-[10px]">添加沟通</span>
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 text-center text-[11px] text-muted-foreground">
          点击选择目标客户后再继续
        </div>
      )}
    </CardShell>
  );
}
