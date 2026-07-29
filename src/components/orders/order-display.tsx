"use client";

import { Badge } from "@/components/ui/badge";

/**
 * 订单展示用纯组件，避免「状态 badge / 金额覆盖标注」在列表展开区与详情页各写一遍导致口径漂移。
 * Props 收敛为最小强类型字段集（不接 Record<string, any>）。
 */

const STATUS_LABELS: Record<string, string> = { DRAFT: "草稿", CONFIRMED: "已确认", DELIVERED: "已交付", CLOSED: "已关闭" };

const BADGE_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  CONFIRMED: "default", DRAFT: "secondary", DELIVERED: "default", CLOSED: "outline",
};

export function orderStatusBadgeVariant(value: string): "default" | "secondary" | "destructive" | "outline" {
  return BADGE_VARIANT[value] || "secondary";
}

export function OrderStatusBadges({
  status,
}: {
  status: string;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Badge variant={orderStatusBadgeVariant(status)}>{STATUS_LABELS[status] || status}</Badge>
    </div>
  );
}

/**
 * 有效金额 = financeAmountOverride ?? totalAmount。
 * 有覆盖时标注「含覆盖」并展示原合同金额，集中此处保证两处展示一致。
 */
export function OrderAmountSummary({
  totalAmount,
  financeAmountOverride,
}: {
  totalAmount: number | null | undefined;
  financeAmountOverride: number | null | undefined;
}) {
  const hasOverride = financeAmountOverride != null;
  const effective = (hasOverride ? financeAmountOverride : totalAmount) ?? 0;
  return (
    <div className="flex items-center gap-1.5">
      <span className="tabular-nums font-medium">¥{effective.toLocaleString()}</span>
      {hasOverride && <span className="text-xs text-amber-600" title="财务覆盖金额生效">含覆盖</span>}
      {hasOverride && totalAmount != null && (
        <span className="text-xs text-muted-foreground">原 ¥{totalAmount.toLocaleString()}</span>
      )}
    </div>
  );
}
