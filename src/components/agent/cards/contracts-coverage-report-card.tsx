"use client";

import { CheckCircle2, XCircle, FileSearch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";

interface CoverageOrder {
  orderId?: string;
  orderNo?: string;
  customerName?: string;
  totalAmountCents?: number;
  hasContract?: boolean;
}

function formatYuan(cents: number | undefined | null): string {
  if (cents == null || Number.isNaN(Number(cents))) return "¥0.00";
  return `¥${(Number(cents) / 100).toFixed(2)}`;
}

/**
 * Coverage report card for `contracts.check_coverage`.
 */
export function ContractsCoverageReportCard({ descriptor }: AgentCardProps) {
  const props = descriptor.props;
  const orders = Array.isArray(props.orders) ? (props.orders as CoverageOrder[]) : [];
  const uncoveredCount = typeof props.uncoveredCount === "number" ? props.uncoveredCount : 0;
  const totalCount = typeof props.totalCount === "number" ? props.totalCount : orders.length;
  const coveredCount = Math.max(totalCount - uncoveredCount, 0);

  return (
    <CardShell title="合同覆盖检查" state={descriptor.state}>
      <div className="flex items-start justify-between gap-2 rounded-xl bg-muted/30 px-3 py-2">
        <div className="flex min-w-0 items-start gap-2">
          <FileSearch className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="text-sm font-medium">
              {uncoveredCount} / {totalCount} 未覆盖
            </div>
            <div className="text-[11px] text-muted-foreground">
              已覆盖 {coveredCount} 笔订单
            </div>
          </div>
        </div>
        <Badge
          variant="outline"
          className={`shrink-0 text-[10px] ${
            uncoveredCount > 0
              ? "bg-amber-50 text-amber-700 border-amber-200"
              : "bg-emerald-50 text-emerald-700 border-emerald-200"
          }`}
        >
          {uncoveredCount > 0 ? "需补合同" : "全部覆盖"}
        </Badge>
      </div>

      {orders.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">订单列表</div>
          <div className="divide-y divide-border/40 overflow-hidden rounded-lg border border-border/40">
            {orders.slice(0, 20).map((order) => (
              <div
                key={order.orderId ?? order.orderNo}
                className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{order.orderNo || order.orderId}</div>
                  {order.customerName ? (
                    <div className="truncate text-[10px] text-muted-foreground">{order.customerName}</div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {typeof order.totalAmountCents === "number" ? (
                    <span className="tabular-nums text-muted-foreground">
                      {formatYuan(order.totalAmountCents)}
                    </span>
                  ) : null}
                  {order.hasContract ? (
                    <Badge
                      variant="outline"
                      className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200"
                    >
                      <CheckCircle2 className="h-3 w-3" />
                      有合同
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="text-[10px] bg-rose-50 text-rose-700 border-rose-200"
                    >
                      <XCircle className="h-3 w-3" />
                      未覆盖
                    </Badge>
                  )}
                </div>
              </div>
            ))}
          </div>
          {orders.length > 20 ? (
            <div className="mt-1.5 text-[10px] text-muted-foreground">仅展示前 20 笔</div>
          ) : null}
        </div>
      ) : null}
    </CardShell>
  );
}
