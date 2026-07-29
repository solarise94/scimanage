"use client";

import { ChevronRight, ShoppingBag, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";

interface LineItem {
  itemName?: string;
  amount?: number;
  quantity?: number;
}

interface ProjectLink {
  projectId?: string;
  projectName?: string;
  allocatedAmount?: number;
  treatment?: string;
}

interface FinanceSummary {
  invoicedAmount?: number;
  receiptAmount?: number;
  outstandingAmount?: number;
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "草稿",
  CONFIRMED: "已确认",
  DELIVERED: "已交付",
  CLOSED: "已关闭",
};

function statusClassName(status?: string): string {
  switch (status) {
    case "CONFIRMED":
      return "bg-blue-50 text-blue-700 border-blue-200";
    case "DELIVERED":
      return "bg-emerald-50 text-emerald-700 border-emerald-200";
    case "CLOSED":
      return "bg-muted text-muted-foreground border-border/60";
    case "DRAFT":
    default:
      return "bg-muted/60 text-muted-foreground border-border/60";
  }
}

function formatYuan(cents: number | undefined | null): string {
  if (cents == null || Number.isNaN(Number(cents))) return "¥0.00";
  return `¥${(Number(cents) / 100).toFixed(2)}`;
}

function displayValue(value: unknown, fallback = "未填写"): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

/**
 * Order detail card (read-only) for `orders.get_detail`.
 *
 * Renders a single order snapshot: order number, title, status, customer,
 * total amount, line items, project links, and finance summary.  No proposal
 * confirmation — purely informational.
 */
export function OrderDetailCard({ descriptor, onApplyViewIntent, onOpenResource }: AgentCardProps) {
  const order = (descriptor.props.order ?? {}) as Record<string, unknown>;
  const orderNo = displayValue(order.orderNo, "-");
  const title = displayValue(order.title, "订单详情");
  const status = typeof order.status === "string" ? order.status : undefined;
  const customerName = displayValue(order.customerName);
  const totalAmount = typeof order.totalAmount === "number" ? order.totalAmount : undefined;
  const items = Array.isArray(descriptor.props.lines)
    ? (descriptor.props.lines as LineItem[])
    : [];
  const projects = Array.isArray(descriptor.props.projectLinks)
    ? (descriptor.props.projectLinks as ProjectLink[])
    : [];
  const finance = (descriptor.props.finance as FinanceSummary | undefined) ?? {};
  const orderId =
    (typeof order.id === "string" ? order.id : undefined) ??
    (typeof descriptor.props.orderId === "string" ? descriptor.props.orderId : undefined);

  return (
    <CardShell
      title={`${title}`}
      state={descriptor.state}
      footer={
        orderId ? (
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-xs"
            onClick={() => {
              // Prefer workspace resource; the server resolver canonicalizes
              // this to `/orders?focus=<id>` (the real entry point — `/orders/<id>`
              // does not exist).  Fall back to navigate intent for shells
              // without the Resource Panel.
              if (onOpenResource) {
                onOpenResource({
                  type: "entity",
                  entityType: "order",
                  entityId: orderId,
                  label: "打开订单详情",
                });
                return;
              }
              onApplyViewIntent({
                type: "focus_entity",
                entityType: "order",
                entityId: orderId,
                label: "打开订单详情",
              });
            }}
          >
            打开订单详情
            <ChevronRight className="h-3 w-3" />
          </Button>
        ) : null
      }
    >
      <div className="flex items-center justify-between gap-2 rounded-xl bg-muted/30 px-3 py-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          <div className="text-[11px] text-muted-foreground">
            单号：{orderNo}
            {customerName !== "未填写" ? ` · 客户：${customerName}` : ""}
          </div>
        </div>
        {status ? (
          <Badge variant="outline" className={`text-[10px] ${statusClassName(status)}`}>
            {STATUS_LABEL[status] ?? status}
          </Badge>
        ) : null}
      </div>

      <div className="mt-3 flex items-center justify-between rounded-xl bg-emerald-50/70 px-3 py-2 text-sm">
        <span className="text-[11px] font-medium text-emerald-900">订单金额</span>
        <span className="font-semibold tabular-nums text-emerald-700">
          {formatYuan(totalAmount)}
        </span>
      </div>

      {items.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <ShoppingBag className="h-3.5 w-3.5" />
            订单项（{items.length}）
          </div>
          <div className="divide-y divide-border/40 overflow-hidden rounded-lg border border-border/40">
            {items.map((item, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <div className="truncate text-foreground">
                    {item.itemName || `订单项 ${idx + 1}`}
                  </div>
                  {item.quantity ? (
                    <div className="text-[11px] text-muted-foreground">数量 {item.quantity}</div>
                  ) : null}
                </div>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatYuan(item.amount)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {projects.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Link2 className="h-3.5 w-3.5" />
            关联项目（{projects.length}）
          </div>
          <div className="space-y-1.5">
            {projects.map((p, idx) => {
              const projectId = typeof p.projectId === "string" ? p.projectId : undefined;
              const projectLabel = (typeof p.projectName === "string" && p.projectName.trim()) || projectId || `项目 ${idx + 1}`;
              return (
                <button
                  key={projectId ?? idx}
                  type="button"
                  className="flex w-full items-center justify-between gap-2 rounded-lg border border-border/40 bg-muted/15 px-3 py-2 text-left text-xs"
                  onClick={() => {
                    if (!projectId) return;
                    if (onOpenResource) {
                      onOpenResource({
                        type: "entity",
                        entityType: "project",
                        entityId: projectId,
                        label: "打开项目详情",
                      });
                      return;
                    }
                    onApplyViewIntent({
                      type: "navigate",
                      route: `/projects/${projectId}`,
                      label: "打开项目详情",
                    });
                  }}
                >
                  <span className="min-w-0 truncate font-medium text-foreground">
                    {projectLabel}
                  </span>
                  <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="mt-3 grid grid-cols-3 gap-2">
        <div className="rounded-lg bg-muted/30 px-2 py-1.5 text-center">
          <div className="text-[10px] text-muted-foreground">已开票</div>
          <div className="text-xs font-medium tabular-nums">{formatYuan(finance.invoicedAmount)}</div>
        </div>
        <div className="rounded-lg bg-muted/30 px-2 py-1.5 text-center">
          <div className="text-[10px] text-muted-foreground">已收款</div>
          <div className="text-xs font-medium tabular-nums text-emerald-600">
            {formatYuan(finance.receiptAmount)}
          </div>
        </div>
        <div className="rounded-lg bg-muted/30 px-2 py-1.5 text-center">
          <div className="text-[10px] text-muted-foreground">未结清</div>
          <div className="text-xs font-medium tabular-nums text-amber-600">
            {formatYuan(finance.outstandingAmount)}
          </div>
        </div>
      </div>
    </CardShell>
  );
}
