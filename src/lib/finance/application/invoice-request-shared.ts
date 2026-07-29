/**
 * Shared helpers for invoice request plan/prepare/submit commands (T6.3).
 */
import type { BusinessActor } from "@/lib/application/actor";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/application/errors";
import { OrderInvoiceRequestWriteError } from "@/lib/finance/order-invoice-request-write";

export type InvoiceRequestItemCommandInput = {
  itemName: string;
  spec?: string | null;
  unit?: string | null;
  quantity?: number | null;
  amountCents: number;
};

export type InvoiceCoverageCommandInput = {
  orderId: string;
  amountCents: number;
};

export function assertAdminInvoiceRequestWrite(actor: BusinessActor): void {
  if (actor.role !== "ADMIN") {
    throw new ForbiddenError();
  }
}

export function resolveCoverageAllocationMap(
  mainOrderId: string,
  allocations: InvoiceCoverageCommandInput[],
  totalAmountCents: number,
): Map<string, number> {
  const allocByOrder = new Map<string, number>();

  if (allocations.length === 0) {
    if (totalAmountCents <= 0) {
      throw new ValidationError("发票金额必须大于 0");
    }
    allocByOrder.set(mainOrderId, totalAmountCents);
    return allocByOrder;
  }

  for (const allocation of allocations) {
    allocByOrder.set(
      allocation.orderId,
      (allocByOrder.get(allocation.orderId) || 0) + allocation.amountCents,
    );
  }
  if (!allocByOrder.has(mainOrderId)) {
    throw new ValidationError("coverageAllocations 必须包含主订单 orderId（完整分摊表）");
  }
  return allocByOrder;
}

export function assertCoverageMatchesTotal(
  allocByOrder: Map<string, number>,
  totalAmountCents: number,
): void {
  const coverageTotal = [...allocByOrder.values()].reduce((sum, value) => sum + value, 0);
  if (coverageTotal !== totalAmountCents) {
    throw new ValidationError(
      `coverageAllocations 合计 ${(coverageTotal / 100).toFixed(2)} 元与发票金额 ${(totalAmountCents / 100).toFixed(2)} 元不一致`,
    );
  }
}

export function mapInvoiceRequestWriteError(err: unknown): never {
  if (err instanceof OrderInvoiceRequestWriteError) {
    if (err.httpStatus === 404) throw new NotFoundError(err.message);
    if (err.httpStatus === 409) throw new ConflictError(err.message);
    throw new ValidationError(err.message);
  }
  throw err;
}
