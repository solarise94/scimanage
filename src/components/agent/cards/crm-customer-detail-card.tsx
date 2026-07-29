"use client";

import { ChevronRight, MessageSquare, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { STAGE_LABELS, IMPORTANCE_LABELS } from "@/lib/crm/constants";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";

interface RecentInteraction {
  id: string;
  type?: string;
  summary?: string;
  happenedAt?: string | null;
}

function formatDate(value?: string | null) {
  if (!value) return "未填写";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未填写";
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function displayValue(value?: string | null) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || "未填写";
}

function stageLabel(stage?: string) {
  if (!stage) return "未填写";
  return STAGE_LABELS[stage] ? `${STAGE_LABELS[stage]} (${stage})` : stage;
}

function importanceLabel(importance?: string) {
  if (!importance) return "未填写";
  return IMPORTANCE_LABELS[importance] ?? importance;
}

/**
 * CRM customer detail card for crm.get_customer_context.
 *
 * Renders a single profile snapshot (not a list). Avoids the empty list card
 * that previously appeared as a large white block when items were missing.
 */
export function CrmCustomerDetailCard({
  descriptor,
  onApplyViewIntent,
  onOpenResource,
  onCreateProposal,
  onSendPrefilled,
}: AgentCardProps) {
  const customerName = displayValue(descriptor.props.customerName as string | undefined);
  const organization = displayValue(descriptor.props.organization as string | undefined);
  const stage = stageLabel(descriptor.props.stage as string | undefined);
  const importance = importanceLabel(descriptor.props.importance as string | undefined);
  // principal = PI / 课题组负责人; ownerName = CRM sales owner.
  const principal = displayValue(descriptor.props.principal as string | undefined);
  const ownerName = displayValue(descriptor.props.ownerName as string | undefined);
  const email = displayValue(descriptor.props.email as string | undefined);
  const wechat = displayValue(descriptor.props.wechat as string | undefined);
  const lastInteractionAt = formatDate(descriptor.props.lastInteractionAt as string | null | undefined);
  const profileId = descriptor.props.profileId as string | undefined;
  const recentInteractions = Array.isArray(descriptor.props.recentInteractions)
    ? (descriptor.props.recentInteractions as RecentInteraction[])
    : [];

  const rows: Array<{ label: string; value: string }> = [
    { label: "客户名", value: customerName },
    { label: "机构", value: organization },
    { label: "阶段", value: stage },
    { label: "重要性", value: importance },
    { label: "负责人", value: ownerName !== "未填写" ? ownerName : principal },
    { label: "邮箱", value: email },
    { label: "微信", value: wechat },
    { label: "最后互动", value: lastInteractionAt },
  ];

  return (
    <CardShell
      title={`${customerName === "未填写" ? "客户" : customerName} · 客户档案`}
      state={descriptor.state}
      footer={
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-auto flex-col items-center gap-1 rounded-lg border-border/50 bg-card py-2.5 shadow-none"
              onClick={() => {
                if (profileId && onCreateProposal) {
                  void onCreateProposal("crm.create_interaction", {
                    profileId,
                    type: "VISIT",
                    summary: "（请填写沟通摘要）",
                    happenedAt: new Date().toISOString(),
                    customerName: customerName === "未填写" ? undefined : customerName,
                  });
                  return;
                }
                if (onSendPrefilled && customerName !== "未填写") {
                  onSendPrefilled(`帮我给${customerName}记一条沟通`, { verifiedCustomerProfileId: profileId });
                }
              }}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              <span className="text-[11px]">记沟通</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-auto flex-col items-center gap-1 rounded-lg border-border/50 bg-card py-2.5 shadow-none"
              onClick={() => {
                if (profileId && onCreateProposal) {
                  void onCreateProposal("crm.prepare_visit_checkin", {
                    profileId,
                    customerName: customerName === "未填写" ? undefined : customerName,
                  });
                  return;
                }
                if (onSendPrefilled && customerName !== "未填写") {
                  onSendPrefilled(`帮我准备${customerName}的现场签到`, { verifiedCustomerProfileId: profileId });
                }
              }}
            >
              <MapPin className="h-3.5 w-3.5" />
              <span className="text-[11px]">签到</span>
            </Button>
          </div>
          {profileId ? (
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-xs"
              onClick={() => {
                // Prefer opening in the workspace Resource Panel/Sheet so the
                // user stays in the conversation.  Fall back to navigate intent
                // for shells that haven't wired up the Resource Panel yet.
                if (onOpenResource) {
                  onOpenResource({
                    type: "entity",
                    entityType: "customer",
                    entityId: profileId,
                    label: "打开客户详情",
                  });
                  return;
                }
                onApplyViewIntent({
                  type: "navigate",
                  route: `/crm/customers/${profileId}`,
                  label: "打开客户详情",
                });
              }}
            >
              打开客户详情
              <ChevronRight className="h-3 w-3" />
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="overflow-hidden border-y border-border/40">
        <dl className="divide-y divide-border/40">
          {rows.map((row) => (
            <div key={row.label} className="grid grid-cols-[72px_1fr] gap-3 px-3.5 py-2.5 text-sm">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0 break-words text-foreground">{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {recentInteractions.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">近期互动</div>
          <div className="space-y-1.5">
            {recentInteractions.slice(0, 3).map((item) => (
              <div
                key={item.id}
                className="rounded-lg border border-border/40 bg-muted/15 px-3 py-2 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground">{item.type || "互动"}</span>
                  <span className="shrink-0 text-muted-foreground">{formatDate(item.happenedAt)}</span>
                </div>
                {item.summary ? (
                  <div className="mt-0.5 line-clamp-2 text-muted-foreground">{item.summary}</div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </CardShell>
  );
}
