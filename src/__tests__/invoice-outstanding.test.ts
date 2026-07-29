import { describe, expect, it } from "vitest";
import { computeInvoiceOutstandingCents } from "@/lib/finance/invoice-outstanding";

describe("computeInvoiceOutstandingCents", () => {
  it("subtracts occupied from total", () => {
    expect(computeInvoiceOutstandingCents(10_000, 3_000)).toBe(7_000);
  });

  it("floors at zero when over-occupied", () => {
    expect(computeInvoiceOutstandingCents(10_000, 12_000)).toBe(0);
  });

  it("treats zero occupied as full outstanding", () => {
    expect(computeInvoiceOutstandingCents(5_500, 0)).toBe(5_500);
  });
});
