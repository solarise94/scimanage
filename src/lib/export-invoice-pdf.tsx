"use client";

import { createRoot } from "react-dom/client";
import { toCanvas } from "html-to-image";
import jsPDF from "jspdf";
import { InvoiceFinanceSheet } from "@/components/invoice-finance-sheet";
import type { InvoiceSheetData } from "@/lib/invoice-sheet";

function sanitizeFilenamePart(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
}

export function buildInvoicePdfFilename(data: InvoiceSheetData): string {
  const buyer = sanitizeFilenamePart(data.buyerOrganizationName) || "开票申请";
  const projectCode = sanitizeFilenamePart(data.projectCode);
  return [buyer, projectCode].filter(Boolean).join("-") + ".pdf";
}

async function waitForRender(): Promise<void> {
  if (typeof document !== "undefined" && "fonts" in document) {
    await document.fonts.ready.catch(() => undefined);
  }
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

export async function exportInvoiceSheetToPdf(
  data: InvoiceSheetData,
  filename = buildInvoicePdfFilename(data),
): Promise<void> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("当前环境不支持导出 PDF");
  }

  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.left = "-10000px";
  host.style.top = "0";
  host.style.width = "718px";
  host.style.background = "#ffffff";
  host.style.zIndex = "-1";
  document.body.appendChild(host);

  const root = createRoot(host);

  try {
    root.render(<InvoiceFinanceSheet data={data} className="!max-w-none" />);
    await waitForRender();

    const sheet = host.querySelector("[data-invoice-sheet]") as HTMLElement | null;
    if (!sheet) throw new Error("PDF 预览生成失败");

    const canvas = await toCanvas(sheet, {
      pixelRatio: 2,
      backgroundColor: "#ffffff",
      cacheBust: true,
    });

    const pdf = new jsPDF({
      orientation: "p",
      unit: "mm",
      format: "a4",
      compress: true,
    });

    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 10;
    const usableWidth = pageWidth - margin * 2;
    const usableHeight = pageHeight - margin * 2;
    const mmPerPx = usableWidth / canvas.width;
    const sliceHeightPx = Math.max(1, Math.floor(usableHeight / mmPerPx));

    let offsetY = 0;
    let pageIndex = 0;

    while (offsetY < canvas.height) {
      const currentSliceHeight = Math.min(sliceHeightPx, canvas.height - offsetY);
      const sliceCanvas = document.createElement("canvas");
      sliceCanvas.width = canvas.width;
      sliceCanvas.height = currentSliceHeight;

      const ctx = sliceCanvas.getContext("2d");
      if (!ctx) throw new Error("PDF 切片生成失败");

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);
      ctx.drawImage(
        canvas,
        0,
        offsetY,
        canvas.width,
        currentSliceHeight,
        0,
        0,
        canvas.width,
        currentSliceHeight,
      );

      if (pageIndex > 0) pdf.addPage();
      pdf.addImage(
        sliceCanvas.toDataURL("image/png"),
        "PNG",
        margin,
        margin,
        usableWidth,
        currentSliceHeight * mmPerPx,
        undefined,
        "FAST",
      );

      offsetY += currentSliceHeight;
      pageIndex += 1;
    }

    pdf.save(filename.endsWith(".pdf") ? filename : `${filename}.pdf`);
  } catch (error) {
    throw error instanceof Error ? error : new Error("PDF 导出失败");
  } finally {
    root.unmount();
    host.remove();
  }
}
