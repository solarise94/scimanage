"use client";

import { FileText } from "lucide-react";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";

export interface CustomerApplicationListItem {
  id: string;
  name: string;
  status: string;
  supervisorReviewStatus?: string;
  createdAt?: string;
}

function statusLabel(status: string) {
  switch (status) {
    case "PENDING":
      return "待审核";
    case "APPROVED":
      return "已通过";
    case "REJECTED":
      return "已拒绝";
    case "CANCELLED":
      return "已取消";
    default:
      return status || "未知";
  }
}

function supervisorReviewLabel(status: string) {
  switch (status) {
    case "PENDING":
      return "待复核";
    case "CONFIRMED":
      return "已确认";
    case "REJECTED":
      return "已拒绝";
    default:
      return status;
  }
}

function formatCreatedAt(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

/**
 * Status line for application list rows.
 * Keeps primary `status`, and appends supervisor review when it is not NONE
 * (auto-approved apps are often APPROVED + supervisorReviewStatus=PENDING).
 */
export function formatCustomerApplicationListStatus(item: {
  status: string;
  supervisorReviewStatus?: string;
  createdAt?: string;
}): string {
  const parts = [statusLabel(item.status)];
  const review = item.supervisorReviewStatus?.trim();
  if (review && review !== "NONE") {
    parts.push(`主管复核：${supervisorReviewLabel(review)}`);
  }
  const created = formatCreatedAt(item.createdAt);
  if (created) parts.push(created);
  return parts.join(" · ");
}

/**
 * Read-only list of the current user's customer applications.
 * Consumes `crm.list_my_customer_applications` output `{ items: [...] }`.
 */
export function CrmCustomerApplicationListCard({ descriptor }: AgentCardProps) {
  const items = (descriptor.props.items as CustomerApplicationListItem[]) ?? [];

  if (items.length === 0) {
    return (
      <CardShell title="我的客户申请" state={descriptor.state}>
        <div className="text-sm text-muted-foreground">
          暂无客户申请。可以说「申请新建客户某某」发起新申请。
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell title={`我的客户申请（${items.length}）`} state={descriptor.state}>
      <div className="divide-y divide-border/50 overflow-hidden border-y border-border/40">
        {items.map((item) => (
          <div key={item.id} className="flex items-start gap-3 px-3.5 py-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/60">
              <FileText className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{item.name || "未命名客户"}</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {formatCustomerApplicationListStatus(item)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </CardShell>
  );
}
