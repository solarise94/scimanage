/**
 * 契约测试：四路发票收集去重优先级
 * 直接导入生产模块 src/lib/finance/invoice-dedup.ts
 */
import { describe, it, expect } from "vitest";
import {
  deduplicateInvoicesByPriority,
  INVOICE_SOURCE_PRIORITY,
  type InvoiceDedupEntry,
} from "@/lib/finance/invoice-dedup";

describe("invoice dedup priority", () => {
  it("COVERAGE overwrites DIRECT for same invoiceId", () => {
    const rows: InvoiceDedupEntry[] = [
      { invoiceId: "inv-1", status: "ISSUED", amountCents: 10000, source: "DIRECT" },
      { invoiceId: "inv-1", status: "ISSUED", amountCents: 8000, source: "COVERAGE" },
    ];
    const result = deduplicateInvoicesByPriority(rows);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("COVERAGE");
    expect(result[0].amountCents).toBe(8000);
  });

  it("DIRECT wins over LEGACY_DIRECT", () => {
    const rows: InvoiceDedupEntry[] = [
      { invoiceId: "inv-1", status: "ISSUED", amountCents: 5000, source: "LEGACY_DIRECT" },
      { invoiceId: "inv-1", status: "REQUESTED", amountCents: 6000, source: "DIRECT" },
    ];
    const result = deduplicateInvoicesByPriority(rows);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("DIRECT");
    expect(result[0].amountCents).toBe(6000);
  });

  it("LEGACY_DIRECT wins over LEGACY_COVERAGE", () => {
    const rows: InvoiceDedupEntry[] = [
      { invoiceId: "inv-1", status: "ISSUED", amountCents: 3000, source: "LEGACY_COVERAGE" },
      { invoiceId: "inv-1", status: "ISSUED", amountCents: 4000, source: "LEGACY_DIRECT" },
    ];
    const result = deduplicateInvoicesByPriority(rows);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("LEGACY_DIRECT");
  });

  it("preserves distinct invoiceIds", () => {
    const rows: InvoiceDedupEntry[] = [
      { invoiceId: "inv-1", status: "ISSUED", amountCents: 1000, source: "DIRECT" },
      { invoiceId: "inv-2", status: "REQUESTED", amountCents: 2000, source: "COVERAGE" },
      { invoiceId: "inv-3", status: "DRAFT", amountCents: 3000, source: "LEGACY_DIRECT" },
    ];
    const result = deduplicateInvoicesByPriority(rows);
    expect(result).toHaveLength(3);
  });

  it("full priority chain: COVERAGE > DIRECT > LEGACY_DIRECT > LEGACY_COVERAGE", () => {
    const rows: InvoiceDedupEntry[] = [
      { invoiceId: "inv-1", status: "DRAFT", amountCents: 100, source: "LEGACY_COVERAGE" },
      { invoiceId: "inv-1", status: "REQUESTED", amountCents: 200, source: "LEGACY_DIRECT" },
      { invoiceId: "inv-1", status: "ISSUED", amountCents: 300, source: "DIRECT" },
      { invoiceId: "inv-1", status: "ISSUED", amountCents: 400, source: "COVERAGE" },
    ];
    const result = deduplicateInvoicesByPriority(rows);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("COVERAGE");
    expect(result[0].amountCents).toBe(400);
  });

  it("order-independent: same result regardless of insertion order", () => {
    const rowsA: InvoiceDedupEntry[] = [
      { invoiceId: "inv-1", status: "ISSUED", amountCents: 100, source: "COVERAGE" },
      { invoiceId: "inv-1", status: "ISSUED", amountCents: 200, source: "DIRECT" },
    ];
    const rowsB: InvoiceDedupEntry[] = [
      { invoiceId: "inv-1", status: "ISSUED", amountCents: 200, source: "DIRECT" },
      { invoiceId: "inv-1", status: "ISSUED", amountCents: 100, source: "COVERAGE" },
    ];
    expect(deduplicateInvoicesByPriority(rowsA)[0].source).toBe("COVERAGE");
    expect(deduplicateInvoicesByPriority(rowsB)[0].source).toBe("COVERAGE");
  });

  it("empty input returns empty", () => {
    expect(deduplicateInvoicesByPriority([])).toHaveLength(0);
  });

  it("priority table is correctly ordered", () => {
    expect(INVOICE_SOURCE_PRIORITY.COVERAGE).toBeLessThan(INVOICE_SOURCE_PRIORITY.DIRECT);
    expect(INVOICE_SOURCE_PRIORITY.DIRECT).toBeLessThan(INVOICE_SOURCE_PRIORITY.LEGACY_DIRECT);
    expect(INVOICE_SOURCE_PRIORITY.LEGACY_DIRECT).toBeLessThan(INVOICE_SOURCE_PRIORITY.LEGACY_COVERAGE);
  });
});
