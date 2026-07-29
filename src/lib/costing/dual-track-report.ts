/**
 * 双轨核对报表——Phase 4 切换前硬验收。
 *
 * 设计文档 §实施阶段建议 Phase 4 smoke：
 * 选 10 笔有 FinanceCost 的订单，双轨核对 sum(FinanceCost) 与
 * getCostSummary(REAL_ONLY).realCost，差异为 0。
 *
 * 此报表按订单对比两套成本来源的差异，帮助确认迁移完成度。
 */
import { prisma } from "@/lib/prisma";
import { COST_BUCKET } from "./constants";
import { getCostSummary } from "./summary";

export interface DualTrackDiffItem {
  orderId: string;
  orderNo: string;
  orderTitle: string;
  /** sum(FinanceCost)，分 */
  financeCostSum: number;
  /** getCostSummary(REAL_ONLY).realCost，分 */
  costEntryRealCost: number;
  /** 差异 = financeCostSum - costEntryRealCost，分 */
  diff: number;
}

export interface DualTrackReport {
  /** 检查的订单总数 */
  checkedOrders: number;
  /** 差异为 0 的订单数 */
  matchedOrders: number;
  /** 有差异的订单数 */
  diffOrders: number;
  /** 总差异（分） */
  totalDiff: number;
  /** 有差异的订单明细 */
  diffs: DualTrackDiffItem[];
}

/**
 * 生成双轨核对报表。
 *
 * @param limit 最大检查订单数（默认全部有 FinanceCost 的订单）
 */
export async function generateDualTrackReport(limit?: number): Promise<DualTrackReport> {
  // 找出所有有 FinanceCost 的订单
  const ordersWithLegacyCost = await prisma.financeCost.findMany({
    where: { orderId: { not: null } },
    select: { orderId: true },
    distinct: ["orderId"],
  });

  const orderIds = ordersWithLegacyCost
    .map((c) => c.orderId!)
    .slice(0, limit ?? ordersWithLegacyCost.length);

  if (orderIds.length === 0) {
    return {
      checkedOrders: 0,
      matchedOrders: 0,
      diffOrders: 0,
      totalDiff: 0,
      diffs: [],
    };
  }

  // 批量查询订单信息
  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: { id: true, orderNo: true, title: true },
  });

  // 批量聚合 FinanceCost（按 orderId）
  const legacyAggs = await prisma.financeCost.groupBy({
    by: ["orderId"],
    where: { orderId: { in: orderIds } },
    _sum: { amount: true },
  });

  const legacyMap = new Map<string, number>();
  for (const agg of legacyAggs) {
    if (agg.orderId) legacyMap.set(agg.orderId, agg._sum.amount ?? 0);
  }

  // 逐订单查 CostEntry 摘要（REAL_ONLY）
  const diffs: DualTrackDiffItem[] = [];
  let matchedOrders = 0;
  let totalDiff = 0;

  for (const order of orders) {
    const financeCostSum = legacyMap.get(order.id) ?? 0;

    const costSummary = await getCostSummary({
      subjectType: "ORDER",
      subjectId: order.id,
      basis: "REAL_ONLY",
    });

    const diff = financeCostSum - costSummary.realCost;

    if (diff === 0) {
      matchedOrders++;
    } else {
      diffs.push({
        orderId: order.id,
        orderNo: order.orderNo,
        orderTitle: order.title,
        financeCostSum,
        costEntryRealCost: costSummary.realCost,
        diff,
      });
      totalDiff += diff;
    }
  }

  // 按差异绝对值降序
  diffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  return {
    checkedOrders: orders.length,
    matchedOrders,
    diffOrders: diffs.length,
    totalDiff,
    diffs,
  };
}
