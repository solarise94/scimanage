import { prisma } from "@/lib/prisma";
import { getBusinessMonthWindow, getRecentBusinessMonthWindows, getShanghaiParts } from "@/lib/business-time";
import { getOrderScopeWhere } from "@/lib/orders/permissions";

export interface OrderMonthlyTrendPoint {
  /** 上海时区自然月，如 "2026-07" */
  month: string;
  /** 展示标签，如 "7月" */
  label: string;
  count: number;
  /** 订单金额合计，单位元 */
  amount: number;
}

export interface OrderDashboardSummary {
  totalCount: number;
  monthNewCount: number;
  lastMonthNewCount: number;
  /** 最近 6 个自然月（含本月）的新增订单数与金额趋势 */
  monthlyTrend: OrderMonthlyTrendPoint[];
}

/**
 * Dashboard/order-list shared base KPI semantics.
 * "本月新增" means orderedAt in the Asia/Shanghai natural month. Null orderedAt
 * is intentionally excluded; deleted and accrual-reversal shadow orders never count.
 * monthlyTrend 沿用同一口径，金额取 totalAmount（分）按月聚合为元。
 */
export async function getOrderDashboardSummary(
  userId: string,
  role: string,
  department: string,
  now: Date = new Date(),
): Promise<OrderDashboardSummary> {
  const scopeWhere = await getOrderScopeWhere(userId, role, prisma, department);
  const baseWhere = {
    AND: [
      ...(scopeWhere ? [scopeWhere] : []),
      { deleted: false },
      { source: { not: "ACCRUAL_REVERSAL" } },
    ],
  };
  const month = getBusinessMonthWindow(now);
  const trendWindows = getRecentBusinessMonthWindows(now, 6);
  const trendStart = trendWindows[0].start;

  const [totalCount, monthNewCount, trendOrders] = await Promise.all([
    prisma.order.count({ where: baseWhere }),
    prisma.order.count({
      where: {
        AND: [
          baseWhere,
          { orderedAt: { not: null, gte: month.start, lt: month.end } },
        ],
      },
    }),
    prisma.order.findMany({
      where: {
        AND: [
          baseWhere,
          { orderedAt: { not: null, gte: trendStart } },
        ],
      },
      select: { orderedAt: true, totalAmount: true },
    }),
  ]);

  const bucketByMonth = new Map<string, { count: number; amountCents: number }>();
  for (const order of trendOrders) {
    if (!order.orderedAt) continue;
    const parts = getShanghaiParts(order.orderedAt);
    const key = `${parts.year}-${String(parts.month).padStart(2, "0")}`;
    const bucket = bucketByMonth.get(key) ?? { count: 0, amountCents: 0 };
    bucket.count += 1;
    bucket.amountCents += order.totalAmount;
    bucketByMonth.set(key, bucket);
  }

  const monthlyTrend: OrderMonthlyTrendPoint[] = trendWindows.map((window) => {
    const bucket = bucketByMonth.get(window.key);
    return {
      month: window.key,
      label: window.label,
      count: bucket?.count ?? 0,
      amount: Math.round((bucket?.amountCents ?? 0) / 100),
    };
  });

  return {
    totalCount,
    monthNewCount,
    lastMonthNewCount: monthlyTrend[monthlyTrend.length - 2]?.count ?? 0,
    monthlyTrend,
  };
}
