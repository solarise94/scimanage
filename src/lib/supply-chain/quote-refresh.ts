/**
 * 报价刷新日期计算 + 供应商报价时间聚合辅助。
 *
 * 设计文档：nextRefreshAt = min(validTo, cycleDeadline)
 *   cycleDeadline = lastUpdatedAt + (updateCycleDays ?? supplier.quoteUpdateCycleDays ?? 90)
 *
 * POST 和 PATCH 都需重算；供应商的 lastQuoteUpdatedAt/nextQuoteRefreshAt
 * 也应在同一事务内重新聚合。
 */
import type { PrismaClient } from "@prisma/client";

const DEFAULT_QUOTE_CYCLE_DAYS = 90;

export function computeNextRefreshAt(params: {
  lastUpdatedAt: Date;
  validTo: Date | null;
  updateCycleDays: number | null;
  supplierQuoteUpdateCycleDays: number | null;
}): Date {
  const cycleDays = params.updateCycleDays ?? params.supplierQuoteUpdateCycleDays ?? DEFAULT_QUOTE_CYCLE_DAYS;
  const cycleDeadline = new Date(params.lastUpdatedAt.getTime() + cycleDays * 24 * 60 * 60 * 1000);
  if (params.validTo && params.validTo < cycleDeadline) {
    return params.validTo;
  }
  return cycleDeadline;
}

/**
 * 重新计算供应商的 lastQuoteUpdatedAt 和 nextQuoteRefreshAt。
 * 必须在报价创建/更新后调用，放在同一 $transaction 内。
 */
export async function recalcSupplierQuoteTimes(
  tx: PrismaClient | Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0],
  supplierId: string,
): Promise<void> {
  const quotes = await tx.supplierQuote.findMany({
    where: { supplierId, status: "ACTIVE" },
    select: { updatedAt: true, nextRefreshAt: true },
    orderBy: { updatedAt: "desc" },
  });
  const lastQuoteUpdatedAt = quotes.length > 0 ? quotes[0].updatedAt : null;
  const nextRefresh = quotes
    .map((q) => q.nextRefreshAt)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());
  await tx.supplier.update({
    where: { id: supplierId },
    data: {
      lastQuoteUpdatedAt,
      nextQuoteRefreshAt: nextRefresh.length > 0 ? nextRefresh[0] : null,
    },
  });
}
