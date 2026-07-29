/**
 * 回归测试：OCR facts 解析器（parseOcrFactsFromStaging）
 * 直接导入生产模块，覆盖损坏 JSON、顶层数组、extracted 数组、字段类型错误等场景。
 */
import { describe, it, expect } from "vitest";
import { parseOcrFactsFromStaging, RegisterIssuedInvoiceError } from "@/lib/finance/register-issued-invoice";

describe("parseOcrFactsFromStaging", () => {
  it("returns null when extractedJson is null/empty", () => {
    expect(parseOcrFactsFromStaging(null)).toBeNull();
    expect(parseOcrFactsFromStaging("")).toBeNull();
    expect(parseOcrFactsFromStaging("   ")).toBeNull();
    expect(parseOcrFactsFromStaging(undefined)).toBeNull();
  });

  it("parses valid flat JSON with amountCents", () => {
    const json = JSON.stringify({ amountCents: 10000, buyerTaxId: "ABC123", sellerTaxId: "DEF456", invoiceType: "增值税专用发票" });
    const result = parseOcrFactsFromStaging(json);
    expect(result).toEqual({
      amountCents: 10000,
      buyerTaxId: "ABC123",
      sellerTaxId: "DEF456",
      invoiceType: "增值税专用发票",
    });
  });

  it("parses nested JSON under 'extracted'", () => {
    const json = JSON.stringify({ extracted: { amountCents: 5000, buyerTaxId: "X" } });
    const result = parseOcrFactsFromStaging(json);
    expect(result?.amountCents).toBe(5000);
    expect(result?.buyerTaxId).toBe("X");
  });

  it("throws on corrupt JSON", () => {
    expect(() => parseOcrFactsFromStaging("not json")).toThrow(RegisterIssuedInvoiceError);
    expect(() => parseOcrFactsFromStaging("{ broken")).toThrow(RegisterIssuedInvoiceError);
  });

  it("throws on top-level array", () => {
    expect(() => parseOcrFactsFromStaging("[1,2,3]")).toThrow(RegisterIssuedInvoiceError);
  });

  it("throws when 'extracted' is an array", () => {
    const json = JSON.stringify({ extracted: [] });
    expect(() => parseOcrFactsFromStaging(json)).toThrow(RegisterIssuedInvoiceError);
    expect(() => parseOcrFactsFromStaging(JSON.stringify({ extracted: [1, 2] }))).toThrow(RegisterIssuedInvoiceError);
  });

  it("throws when amountCents is wrong type (string)", () => {
    const json = JSON.stringify({ amountCents: "10000" });
    expect(() => parseOcrFactsFromStaging(json)).toThrow(RegisterIssuedInvoiceError);
  });

  it("throws when buyerTaxId is wrong type (number)", () => {
    const json = JSON.stringify({ buyerTaxId: 12345 });
    expect(() => parseOcrFactsFromStaging(json)).toThrow(RegisterIssuedInvoiceError);
  });

  it("throws when sellerTaxId is wrong type (boolean)", () => {
    const json = JSON.stringify({ sellerTaxId: true });
    expect(() => parseOcrFactsFromStaging(json)).toThrow(RegisterIssuedInvoiceError);
  });

  it("throws when invoiceType is wrong type (number)", () => {
    const json = JSON.stringify({ invoiceType: 42 });
    expect(() => parseOcrFactsFromStaging(json)).toThrow(RegisterIssuedInvoiceError);
  });

  it("returns null amountCents when field is absent", () => {
    const json = JSON.stringify({ buyerTaxId: "X" });
    const result = parseOcrFactsFromStaging(json);
    expect(result?.amountCents).toBeNull();
    expect(result?.buyerTaxId).toBe("X");
  });

  it("normalizes UNKNOWN invoiceType to null", () => {
    const json = JSON.stringify({ invoiceType: "UNKNOWN" });
    const result = parseOcrFactsFromStaging(json);
    expect(result?.invoiceType).toBeNull();
  });

  it("accepts totalAmount as fallback for amountCents", () => {
    const json = JSON.stringify({ totalAmount: 20000 });
    const result = parseOcrFactsFromStaging(json);
    expect(result?.amountCents).toBe(20000);
  });

  it("accepts totalAmountCents as fallback for amountCents", () => {
    const json = JSON.stringify({ totalAmountCents: 30000 });
    const result = parseOcrFactsFromStaging(json);
    expect(result?.amountCents).toBe(30000);
  });

  it("all error cases throw RegisterIssuedInvoiceError with OCR_FACTS_CORRUPT code", () => {
    try {
      parseOcrFactsFromStaging("not json");
    } catch (e) {
      expect(e).toBeInstanceOf(RegisterIssuedInvoiceError);
      expect((e as RegisterIssuedInvoiceError).code).toBe("OCR_FACTS_CORRUPT");
      expect((e as RegisterIssuedInvoiceError).httpStatus).toBe(400);
    }
  });
});
