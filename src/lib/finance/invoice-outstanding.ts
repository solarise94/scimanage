/**
 * 发票剩余可核销金额（outstanding）统一口径。
 *
 * 与 `createAllocationReceipt` / `getInvoiceOccupiedAmount` 写入侧一致：
 *   occupied = Σ(FinanceReceiptAllocation where receipt.deleted=false)
 *            + Σ(legacy FinanceReceipt where externalOrderInvoiceRequestId=invoice
 *                AND deleted=false AND allocations: { none: {} })
 *   outstanding = max(totalAmount - occupied, 0)
 *
 * 禁止：
 * - allocations + 全部 legacy receipts 相加（已有 allocation 的 legacy 会双计）
 * - max(allocations, legacy)（混合历史数据下会低估占用）
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { collectByChunks } from "@/lib/finance/query-chunk";

type DbClient = Prisma.TransactionClient | typeof prisma;

export function computeInvoiceOutstandingCents(
  totalAmountCents: number,
  occupiedCents: number,
): number {
  return Math.max(totalAmountCents - occupiedCents, 0);
}

/**
 * 批量加载发票已占用金额（分），口径见文件头。
 * 未出现在结果 Map 中的 invoiceId 视为占用 0。
 */
export async function loadInvoiceOccupiedAmounts(
  invoiceIds: string[],
  client: DbClient = prisma,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (invoiceIds.length === 0) return result;

  const [allocAggs, legacyAggs] = await Promise.all([
    collectByChunks(invoiceIds, (chunk) =>
      client.financeReceiptAllocation.groupBy({
        by: ["invoiceId"],
        where: { invoiceId: { in: chunk }, receipt: { deleted: false } },
        _sum: { amount: true },
      }),
    ),
    collectByChunks(invoiceIds, (chunk) =>
      client.financeReceipt.groupBy({
        by: ["externalOrderInvoiceRequestId"],
        where: {
          externalOrderInvoiceRequestId: { in: chunk },
          deleted: false,
          allocations: { none: {} },
        },
        _sum: { amount: true },
      }),
    ),
  ]);

  for (const a of allocAggs) {
    result.set(a.invoiceId, (result.get(a.invoiceId) || 0) + (a._sum.amount || 0));
  }
  for (const l of legacyAggs) {
    if (!l.externalOrderInvoiceRequestId) continue;
    result.set(
      l.externalOrderInvoiceRequestId,
      (result.get(l.externalOrderInvoiceRequestId) || 0) + (l._sum.amount || 0),
    );
  }
  return result;
}

/** 批量计算 outstanding（分）。 */
export async function loadInvoiceOutstandingAmounts(
  invoices: Array<{ id: string; totalAmount: number }>,
  client: DbClient = prisma,
): Promise<Map<string, number>> {
  const occupied = await loadInvoiceOccupiedAmounts(
    invoices.map((i) => i.id),
    client,
  );
  const out = new Map<string, number>();
  for (const inv of invoices) {
    out.set(
      inv.id,
      computeInvoiceOutstandingCents(inv.totalAmount, occupied.get(inv.id) || 0),
    );
  }
  return out;
}
