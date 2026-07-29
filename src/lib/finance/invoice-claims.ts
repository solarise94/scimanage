/**
 * 已开发票号 / 文件哈希占用锁的生命周期。
 *
 * 锁在 registerIssuedInvoiceDocument 成功时创建；在以下场景释放：
 * - 删除 InvoiceDocument（释放该附件的文件哈希锁，便于 ISSUED 无附件恢复）
 * - 冲红 / 重开原发票（释放该申请的号锁与文件哈希锁）
 * - 申请取消为 CANCELLED（防御性释放）
 *
 * 同 invoiceRequestId 重登记允许票号重入（upsert），不把自有锁当成冲突。
 */

import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

export async function releaseInvoiceFileHashClaimByDocumentId(
  tx: Tx,
  documentId: string,
): Promise<void> {
  await tx.issuedInvoiceFileHashClaim.deleteMany({ where: { documentId } });
}

export async function releaseInvoiceClaimsForRequest(
  tx: Tx,
  invoiceRequestId: string,
): Promise<void> {
  await tx.issuedInvoiceNumberClaim.deleteMany({ where: { invoiceRequestId } });
  await tx.issuedInvoiceFileHashClaim.deleteMany({ where: { invoiceRequestId } });
}

/**
 * 占用发票号：允许同一申请重入；其他申请占用时抛出由调用方映射的冲突。
 * @returns "created" | "reused" | "updated"
 */
export async function claimIssuedInvoiceNumber(
  tx: Tx,
  opts: { actualInvoiceNo: string; invoiceRequestId: string },
): Promise<"created" | "reused" | "updated"> {
  const existingByRequest = await tx.issuedInvoiceNumberClaim.findUnique({
    where: { invoiceRequestId: opts.invoiceRequestId },
  });
  if (existingByRequest) {
    if (existingByRequest.actualInvoiceNo === opts.actualInvoiceNo) {
      return "reused";
    }
    await tx.issuedInvoiceNumberClaim.delete({
      where: { invoiceRequestId: opts.invoiceRequestId },
    });
  }

  const existingByNumber = await tx.issuedInvoiceNumberClaim.findUnique({
    where: { actualInvoiceNo: opts.actualInvoiceNo },
  });
  if (existingByNumber && existingByNumber.invoiceRequestId !== opts.invoiceRequestId) {
    const err = new Error("INVOICE_NUMBER_DUPLICATE");
    (err as Error & { code: string }).code = "INVOICE_NUMBER_DUPLICATE";
    throw err;
  }

  await tx.issuedInvoiceNumberClaim.create({
    data: {
      actualInvoiceNo: opts.actualInvoiceNo,
      invoiceRequestId: opts.invoiceRequestId,
    },
  });
  return existingByRequest ? "updated" : "created";
}

/**
 * 占用文件哈希：若同申请已有该哈希锁则更新 documentId；跨申请冲突抛错。
 */
export async function claimIssuedInvoiceFileHash(
  tx: Tx,
  opts: { sha256: string; invoiceRequestId: string; documentId: string },
): Promise<void> {
  const existing = await tx.issuedInvoiceFileHashClaim.findUnique({
    where: { sha256: opts.sha256 },
  });
  if (existing) {
    if (existing.invoiceRequestId !== opts.invoiceRequestId) {
      const err = new Error("INVOICE_FILE_DUPLICATE");
      (err as Error & { code: string }).code = "INVOICE_FILE_DUPLICATE";
      throw err;
    }
    await tx.issuedInvoiceFileHashClaim.update({
      where: { sha256: opts.sha256 },
      data: { documentId: opts.documentId },
    });
    return;
  }

  // Drop any stale claim for this document id (shouldn't normally exist).
  await tx.issuedInvoiceFileHashClaim.deleteMany({
    where: { documentId: opts.documentId },
  });

  await tx.issuedInvoiceFileHashClaim.create({
    data: {
      sha256: opts.sha256,
      invoiceRequestId: opts.invoiceRequestId,
      documentId: opts.documentId,
    },
  });
}
