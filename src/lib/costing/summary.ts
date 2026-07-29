/**
 * 成本摘要查询——getCostSummary()。
 *
 * 设计文档 §成本摘要接口：
 * - 优先读 CostSnapshot，必要时 fallback 到 CostEntry 聚合。
 * - 属于内部 lib，所有金额返回单位均为分。
 *
 * 利润口径（设计文档 §成本口径）：
 *   供应链毛利 = 订单收入 - REAL
 *   经营毛利 = 订单收入 - REAL - CIRCULATION
 *   净贡献 = 订单收入 - REAL - CIRCULATION - TAX
 */
import { prisma } from "@/lib/prisma";
import {
  COST_SUBJECT_TYPE,
  bucketsForBasis,
  type CostBasis,
} from "./constants";
import { recomputeCostSnapshot } from "./recompute";
import type {
  CostSummary,
  GetCostSummaryParams,
  MarginResult,
} from "./types";

/**
 * 获取成本摘要。优先读 CostSnapshot。
 *
 * 若 forceRefresh=true，先重算再读。
 */
export async function getCostSummary(
  params: GetCostSummaryParams,
  options?: { forceRefresh?: boolean },
): Promise<CostSummary> {
  const { subjectType, subjectId, basis } = params;

  if (options?.forceRefresh) {
    await recomputeCostSnapshot({ subjectType: subjectType as never, subjectId });
  }

  const snapshot = await prisma.costSnapshot.findUnique({
    where: { subjectType_subjectId: { subjectType, subjectId } },
  });

  if (!snapshot) {
    // fallback：重算一次再读
    await recomputeCostSnapshot({ subjectType: subjectType as never, subjectId });
  }

  const snap =
    snapshot ??
    (await prisma.costSnapshot.findUnique({
      where: { subjectType_subjectId: { subjectType, subjectId } },
    }));

  const realCost = snap?.realCost ?? 0;
  const circulationCost = snap?.circulationCost ?? 0;
  const taxCost = snap?.taxCost ?? 0;

  // 按口径计算 totalCost
  const buckets = bucketsForBasis(basis as CostBasis);
  let totalCost = 0;
  if (buckets.includes("REAL" as never)) totalCost += realCost;
  if (buckets.includes("CIRCULATION" as never)) totalCost += circulationCost;
  if (buckets.includes("TAX" as never)) totalCost += taxCost;

  return {
    subjectType,
    subjectId,
    basis,
    realCost,
    circulationCost,
    taxCost,
    totalCost,
    estimatedCost: snap?.estimatedCost ?? 0,
    quotedCost: snap?.quotedCost ?? 0,
    committedCost: snap?.committedCost ?? 0,
    actualCost: snap?.actualCost ?? 0,
    settledCost: snap?.settledCost ?? 0,
  };
}

/**
 * 获取订单收入（financeAmountOverride ?? totalAmount）。
 */
export async function getOrderRevenue(orderId: string): Promise<number> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { totalAmount: true, financeAmountOverride: true },
  });
  if (!order) return 0;
  return order.financeAmountOverride ?? order.totalAmount ?? 0;
}

/**
 * 计算订单利润口径。
 * 收入来自订单，成本来自 getCostSummary(ORDER)。
 */
export async function getOrderMargin(
  orderId: string,
  basis: CostBasis,
): Promise<MarginResult & { costSummary: CostSummary }> {
  const revenue = await getOrderRevenue(orderId);
  const costSummary = await getCostSummary({
    subjectType: COST_SUBJECT_TYPE.ORDER,
    subjectId: orderId,
    basis,
  });

  const supplyChainGrossMargin = revenue - costSummary.realCost;
  const operatingGrossMargin = revenue - costSummary.realCost - costSummary.circulationCost;
  const netContribution = revenue - costSummary.realCost - costSummary.circulationCost - costSummary.taxCost;
  const netContributionRate = revenue > 0 ? netContribution / revenue : null;

  return {
    revenue,
    supplyChainGrossMargin,
    operatingGrossMargin,
    netContribution,
    netContributionRate,
    costSummary,
  };
}
