import { prisma } from "@/lib/prisma";
import { collectByChunks } from "./query-chunk";

/**
 * Compute ISSUED invoice totals per order, covering both
 * direct ExternalOrderInvoiceRequest.orderId and OrderInvoiceCoverage.orderId.
 * Deduplicates by invoiceRequest.id so the same invoice counted via both paths
 * is not double-counted.
 *
 * §4.1: coverage 金额直接读 OrderInvoiceCoverage.amount，不再按比例分摊。
 */
export async function getOrderInvoiceTotals(orderIds: string[]): Promise<Map<string, number>> {
  if (orderIds.length === 0) return new Map();

  // per-order → set of invoiceRequest IDs with their amount
  const perOrder = new Map<string, Map<string, number>>();
  const add = (orderId: string | null, invoiceId: string, amount: number) => {
    if (!orderId) return;
    let invMap = perOrder.get(orderId);
    if (!invMap) { invMap = new Map(); perOrder.set(orderId, invMap); }
    invMap.set(invoiceId, amount);
  };

  // Direct: orderId on invoice request
  const direct = await collectByChunks(orderIds, (chunk) =>
    prisma.externalOrderInvoiceRequest.findMany({
      where: { orderId: { in: chunk }, status: "ISSUED", adjustmentsAsOriginal: { none: { kind: { in: ["RED", "REISSUE"] } } } },
      select: { id: true, orderId: true, totalAmount: true },
    })
  );
  for (const inv of direct) {
    add(inv.orderId, inv.id, inv.totalAmount);
  }

  // Coverage: via OrderInvoiceCoverage.amount
  const coverage = await collectByChunks(orderIds, (chunk) =>
    prisma.orderInvoiceCoverage.findMany({
      where: {
        orderId: { in: chunk },
        invoiceRequest: { status: "ISSUED", adjustmentsAsOriginal: { none: { kind: { in: ["RED", "REISSUE"] } } } },
      },
      select: {
        orderId: true,
        amount: true,
        invoiceRequest: { select: { id: true } },
      },
    })
  );
  for (const cov of coverage) {
    add(cov.orderId, cov.invoiceRequest.id, cov.amount);
  }

  // Sum deduped amounts per order
  const result = new Map<string, number>();
  for (const [orderId, invMap] of perOrder) {
    let total = 0;
    for (const amount of invMap.values()) total += amount;
    result.set(orderId, total);
  }
  return result;
}

/**
 * Compute GLOBAL invoice total across orders — deduplicates merged invoices
 * that may cover multiple orders. Used for aggregate stats.
 */
export async function getGlobalInvoiceTotal(orderIds: string[]): Promise<number> {
  if (orderIds.length === 0) return 0;

  // Collect all unique invoice requests that touch these orders
  const directInvoices = await collectByChunks(orderIds, (chunk) =>
    prisma.externalOrderInvoiceRequest.findMany({
      where: { orderId: { in: chunk }, status: "ISSUED", adjustmentsAsOriginal: { none: { kind: { in: ["RED", "REISSUE"] } } } },
      select: { id: true, totalAmount: true },
    })
  );

  const coverageInvoices = await collectByChunks(orderIds, (chunk) =>
    prisma.orderInvoiceCoverage.findMany({
      where: {
        orderId: { in: chunk },
        invoiceRequest: { status: "ISSUED", adjustmentsAsOriginal: { none: { kind: { in: ["RED", "REISSUE"] } } } },
      },
      select: { invoiceRequest: { select: { id: true, totalAmount: true } } },
    })
  );

  // Deduplicate by invoice request ID, then sum
  const seen = new Set<string>();
  let total = 0;
  for (const inv of directInvoices) {
    if (seen.has(inv.id)) continue;
    seen.add(inv.id);
    total += inv.totalAmount;
  }
  for (const cov of coverageInvoices) {
    const id = cov.invoiceRequest.id;
    if (seen.has(id)) continue;
    seen.add(id);
    total += cov.invoiceRequest.totalAmount;
  }
  return total;
}

/**
 * Compute receipt totals per order.
 * Aggregates from FinanceReceiptAllocation (new path) + legacy FinanceReceipt.orderId (1-to-1).
 * All queries filter receipt.deleted = false per §1.1 S6.
 */
export async function getOrderReceiptTotals(orderIds: string[]): Promise<Map<string, number>> {
  if (orderIds.length === 0) return new Map();

  const result = new Map<string, number>();

  // New path: FinanceReceiptAllocation (primary source per §1.1 S1)
  const allocations = await collectByChunks(orderIds, (chunk) =>
    prisma.financeReceiptAllocation.findMany({
      where: {
        orderId: { in: chunk },
        receipt: { deleted: false },
      },
      select: { orderId: true, amount: true },
    })
  );
  for (const a of allocations) {
    if (a.orderId) {
      result.set(a.orderId, (result.get(a.orderId) || 0) + a.amount);
    }
  }

  // Legacy path: FinanceReceipt.orderId (1-to-1, backward compatible per §4.3)
  const legacyReceipts = await collectByChunks(orderIds, (chunk) =>
    prisma.financeReceipt.findMany({
      where: {
        orderId: { in: chunk },
        deleted: false,
        allocations: { none: {} }, // exclude receipts that already have allocations (avoid double-count)
      },
      select: { orderId: true, amount: true },
    })
  );
  for (const r of legacyReceipts) {
    if (r.orderId) {
      result.set(r.orderId, (result.get(r.orderId) || 0) + r.amount);
    }
  }

  return result;
}

/**
 * Compute cost totals per order from FinanceCost.orderId.
 * FinanceCost has no soft-delete column; rows are hard-deleted, so no deleted filter.
 * Returns Map<orderId, cents> (mirrors getOrderReceiptTotals shape).
 */
export async function getOrderCostTotals(orderIds: string[]): Promise<Map<string, number>> {
  if (orderIds.length === 0) return new Map();

  const result = new Map<string, number>();
  const costs = await collectByChunks(orderIds, (chunk) =>
    prisma.financeCost.findMany({
      where: { orderId: { in: chunk } },
      select: { orderId: true, amount: true },
    })
  );
  for (const c of costs) {
    if (c.orderId) {
      result.set(c.orderId, (result.get(c.orderId) || 0) + c.amount);
    }
  }
  return result;
}

/**
 * Compute the GLOBAL receipt total across orders (deduped) for aggregate stats.
 * Sums FinanceReceiptAllocation (new path) + legacy FinanceReceipt.orderId,
 * excluding legacy receipts that already have allocations to avoid double-count.
 * All queries filter receipt.deleted = false.
 */
export async function getGlobalReceiptTotal(orderIds: string[]): Promise<number> {
  if (orderIds.length === 0) return 0;

  // New path: FinanceReceiptAllocation
  const allocations = await collectByChunks(orderIds, (chunk) =>
    prisma.financeReceiptAllocation.findMany({
      where: {
        orderId: { in: chunk },
        receipt: { deleted: false },
      },
      select: { amount: true },
    })
  );
  const allocTotal = allocations.reduce((s, a) => s + a.amount, 0);

  // Legacy path: FinanceReceipt.orderId (1-to-1, exclude receipts with allocations to avoid double-count)
  const legacyReceipts = await collectByChunks(orderIds, (chunk) =>
    prisma.financeReceipt.findMany({
      where: {
        orderId: { in: chunk },
        deleted: false,
        allocations: { none: {} },
      },
      select: { amount: true },
    })
  );
  const legacyTotal = legacyReceipts.reduce((s, r) => s + r.amount, 0);

  return allocTotal + legacyTotal;
}
