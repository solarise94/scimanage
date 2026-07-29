/**
 * 四路发票收集的统一去重逻辑。
 *
 * 优先级（高 → 低）：COVERAGE > DIRECT > LEGACY_DIRECT > LEGACY_COVERAGE
 *
 * - COVERAGE（OrderInvoiceCoverage）：分摊表事实源，金额可能与发票 totalAmount 不同
 * - DIRECT（ExternalOrderInvoiceRequest.orderId）：新系统直接关联
 * - LEGACY_DIRECT（ExternalOrderInvoiceRequest.externalOrderId）：旧系统直接关联
 * - LEGACY_COVERAGE（ExternalOrderInvoiceCoverage.externalOrderId）：旧系统分摊
 *
 * 同一 invoiceId 只保留优先级最高的来源及其金额。
 */

export type InvoiceDedupSource = "DIRECT" | "COVERAGE" | "LEGACY_DIRECT" | "LEGACY_COVERAGE";

export const INVOICE_SOURCE_PRIORITY: Record<InvoiceDedupSource, number> = {
  COVERAGE: 0,
  DIRECT: 1,
  LEGACY_DIRECT: 2,
  LEGACY_COVERAGE: 3,
};

export interface InvoiceDedupEntry {
  invoiceId: string;
  status: string;
  amountCents: number;
  source: InvoiceDedupSource;
}

/**
 * 按 invoiceId 去重，保留优先级最高的来源。
 * 输入顺序无关——结果仅由 source 优先级决定。
 */
export function deduplicateInvoicesByPriority<T extends InvoiceDedupEntry>(rows: T[]): T[] {
  const map = new Map<string, T>();
  for (const row of rows) {
    const existing = map.get(row.invoiceId);
    if (!existing || INVOICE_SOURCE_PRIORITY[row.source] < INVOICE_SOURCE_PRIORITY[existing.source]) {
      map.set(row.invoiceId, row);
    }
  }
  return [...map.values()];
}
