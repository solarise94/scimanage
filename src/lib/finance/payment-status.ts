import { prisma } from "@/lib/prisma";

export type PaymentStatus = "UNPAID" | "PARTIAL" | "PAID";

export function computePaymentStatus(totalAmount: number, receiptTotal: number): PaymentStatus {
  if (receiptTotal <= 0) return "UNPAID";
  if (receiptTotal >= totalAmount) return "PAID";
  return "PARTIAL";
}

/**
 * Compute invoice payment status aggregating from both:
 *  - FinanceReceiptAllocation (new path, primary per §1.1 S1)
 *  - Legacy FinanceReceipt.externalOrderInvoiceRequestId (1-to-1)
 * All queries filter receipt.deleted = false per §1.1 S6.
 */
export async function computeInvoicePaymentStatus(
  invoiceId: string,
  type: "project" | "order",
): Promise<{ receiptTotal: number; paymentStatus: PaymentStatus }> {
  let receiptTotal = 0;

  if (type === "project") {
    const receipts = await prisma.financeReceipt.findMany({
      where: { projectInvoiceId: invoiceId, deleted: false },
      select: { amount: true },
    });
    receiptTotal = receipts.reduce((sum, r) => sum + r.amount, 0);

    const invoice = await prisma.projectInvoice.findUnique({
      where: { id: invoiceId },
      select: { totalAmount: true },
    });
    return { receiptTotal, paymentStatus: computePaymentStatus(invoice?.totalAmount ?? 0, receiptTotal) };
  }

  // New path: FinanceReceiptAllocation (primary)
  const allocations = await prisma.financeReceiptAllocation.findMany({
    where: {
      invoiceId,
      receipt: { deleted: false },
    },
    select: { amount: true },
  });
  receiptTotal = allocations.reduce((sum, a) => sum + a.amount, 0);

  // Legacy path: FinanceReceipt.externalOrderInvoiceRequestId (1-to-1)
  // Only count receipts WITHOUT allocations to avoid double-counting
  const legacyReceipts = await prisma.financeReceipt.findMany({
    where: {
      externalOrderInvoiceRequestId: invoiceId,
      deleted: false,
      allocations: { none: {} },
    },
    select: { amount: true },
  });
  receiptTotal += legacyReceipts.reduce((sum, r) => sum + r.amount, 0);

  const invoice = await prisma.externalOrderInvoiceRequest.findUnique({
    where: { id: invoiceId },
    select: { totalAmount: true },
  });
  return { receiptTotal, paymentStatus: computePaymentStatus(invoice?.totalAmount ?? 0, receiptTotal) };
}
