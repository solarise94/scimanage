import { jsPDF } from "jspdf";
import { describe, expect, it } from "vitest";
import { extractPdfText } from "@/lib/agent-attachments/pdf-text";

function makeTextPdf(lines: string[]): Buffer {
  const pdf = new jsPDF();
  pdf.text(lines, 20, 20);
  return Buffer.from(pdf.output("arraybuffer"));
}

describe("extractPdfText", () => {
  it("提取文本型 PDF 的内容", async () => {
    const input = makeTextPdf([
      "Invoice No: INV-20260724",
      "Customer: Solarise Lab",
      "Amount: CNY 12800.00",
    ]);

    await expect(extractPdfText(input)).resolves.toContain("INV-20260724");
    await expect(extractPdfText(input)).resolves.toContain("Solarise Lab");
  });

  it("按调用方指定的字符上限截断", async () => {
    const input = makeTextPdf(["ABCDEFGHIJKLMNOPQRSTUVWXYZ"]);

    await expect(extractPdfText(input, 8)).resolves.toBe("ABCDEFGH");
  });
});
