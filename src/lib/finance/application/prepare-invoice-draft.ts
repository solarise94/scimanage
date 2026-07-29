/**
 * Canonical actor-aware prepare invoice draft command (T6.3).
 *
 * Shared by Web `POST /api/finance/order-invoices` and Agent
 * `finance.prepare_invoice_draft`. Creates DRAFT with compatible buyer rules.
 */
import type { BusinessActor, InvocationContext } from "@/lib/application/actor";
import { NotFoundError, ValidationError } from "@/lib/application/errors";
import { validateTouchedOrders } from "@/lib/finance/order-invoices";
import {
  createOrderInvoiceRequest,
  type CreateOrderInvoiceRequestResult,
} from "@/lib/finance/order-invoice-request-write";
import { prisma } from "@/lib/prisma";
import { assertFullOrderScopeForActor } from "@/lib/finance/application/invoice-order-scope";
import {
  assertAdminInvoiceRequestWrite,
  assertCoverageMatchesTotal,
  type InvoiceCoverageCommandInput,
  type InvoiceRequestItemCommandInput,
  mapInvoiceRequestWriteError,
  resolveCoverageAllocationMap,
} from "@/lib/finance/application/invoice-request-shared";

export type PrepareInvoiceDraftCommandInput = {
  mainOrderId: string;
  coverageAllocations: InvoiceCoverageCommandInput[];
  allowCrossOrgInvoice?: boolean;
  contactName?: string | null;
  sellerProfileId?: string | null;
  sellerName?: string | null;
  buyerOrganizationId?: string | null;
  buyerOrganizationName: string;
  buyerTaxId?: string | null;
  buyerTaxIdFromLookup?: boolean;
  invoiceType: "NORMAL" | "SPECIAL";
  contentSummary?: string | null;
  remark?: string | null;
  items: InvoiceRequestItemCommandInput[];
  sourceAgentProposalId?: string | null;
};

export type PrepareInvoiceDraftPreview = {
  title: string;
  summary: string;
  target: { type: "order"; id: string };
  mainOrderNo: string | null;
  touchedOrderCount: number;
  totalAmountCents: number;
};

export type PrepareInvoiceDraftResult = {
  invoice: {
    id: string;
    orderId: string;
    buyerOrganizationName: string;
    totalAmount: number;
    status: string;
  };
  coveredOrderCount: number;
};

function normalizeItems(items: InvoiceRequestItemCommandInput[]) {
  return items.filter((item) => item.itemName.trim());
}

export async function previewPrepareInvoiceDraftForActor(
  actor: BusinessActor,
  input: PrepareInvoiceDraftCommandInput,
): Promise<PrepareInvoiceDraftPreview> {
  assertAdminInvoiceRequestWrite(actor);

  const order = await prisma.order.findUnique({
    where: { id: input.mainOrderId, deleted: false },
    select: { id: true, orderNo: true, title: true },
  });
  if (!order) {
    throw new NotFoundError("主订单不存在");
  }

  const itemRows = normalizeItems(input.items);
  const totalAmountCents = itemRows.reduce((sum, item) => sum + item.amountCents, 0);
  const allocByOrder = resolveCoverageAllocationMap(
    input.mainOrderId,
    input.coverageAllocations,
    totalAmountCents,
  );
  assertCoverageMatchesTotal(allocByOrder, totalAmountCents);

  const touchedOrderIds = [...allocByOrder.keys()];
  await assertFullOrderScopeForActor(actor, touchedOrderIds);

  const validation = await validateTouchedOrders(touchedOrderIds, allocByOrder, {
    allowCrossOrgInvoice: !!input.allowCrossOrgInvoice,
  });
  if (!validation.ok) {
    const body = validation.body;
    if (body.code === "INVOICEABLE_EXCEEDED") {
      throw new ValidationError(
        `订单 ${String(body.orderId).slice(-6)} 剩余可开票额不足：剩余 ${(Number(body.remaining) / 100).toFixed(2)} 元，本次 ${(Number(body.allocating) / 100).toFixed(2)} 元`,
      );
    }
    throw new ValidationError(String(body.error || body.message || "开票前置校验失败"));
  }

  return {
    title: `创建发票草稿：${order.orderNo}`,
    summary: `将为订单「${order.orderNo} ${order.title}」创建发票草稿，购方为「${input.buyerOrganizationName}」，覆盖 ${touchedOrderIds.length} 笔订单，金额 ${(totalAmountCents / 100).toFixed(2)} 元。`,
    target: { type: "order", id: order.id },
    mainOrderNo: order.orderNo,
    touchedOrderCount: touchedOrderIds.length,
    totalAmountCents,
  };
}

export async function prepareInvoiceDraftForActor(
  actor: BusinessActor,
  input: PrepareInvoiceDraftCommandInput,
  opts: { invocation?: InvocationContext } = {},
): Promise<PrepareInvoiceDraftResult> {
  assertAdminInvoiceRequestWrite(actor);

  const itemRows = normalizeItems(input.items);
  const totalAmountCents = itemRows.reduce((sum, item) => sum + item.amountCents, 0);
  const allocByOrder = resolveCoverageAllocationMap(
    input.mainOrderId,
    input.coverageAllocations,
    totalAmountCents,
  );
  assertCoverageMatchesTotal(allocByOrder, totalAmountCents);

  const touchedOrderIds = [...allocByOrder.keys()];
  await assertFullOrderScopeForActor(actor, touchedOrderIds);

  // Phase E（P0-3）：Agent 开票——事务外 early pre-check；权威复核在
  // createOrderInvoiceRequest 最终写事务内（agentOwnerRecheck，防 TOCTOU）。
  if (opts.invocation?.channel === "agent") {
    const { assertAgentCanWriteOrders } = await import("@/lib/orders/application/technical-owner-gate");
    await assertAgentCanWriteOrders(actor, opts.invocation, touchedOrderIds);
  }

  try {
    const result: CreateOrderInvoiceRequestResult = await createOrderInvoiceRequest({
      mainOrderId: input.mainOrderId,
      coverageAllocations: [...allocByOrder.entries()].map(([orderId, amountCents]) => ({
        orderId,
        amountCents,
      })),
      buyerOrganizationId: input.buyerOrganizationId || null,
      buyerOrganizationName: input.buyerOrganizationName,
      buyerTaxId: input.buyerTaxId || null,
      buyerTaxIdFromLookup: !!input.buyerTaxIdFromLookup,
      sellerProfileId: input.sellerProfileId || null,
      sellerName: input.sellerName || null,
      invoiceType: input.invoiceType,
      contactName: input.contactName || null,
      contentSummary: input.contentSummary || null,
      remark: input.remark || null,
      items: itemRows,
      targetStatus: "DRAFT",
      createdById: actor.userId,
      sourceAgentProposalId: input.sourceAgentProposalId ?? null,
      allowCrossOrgInvoice: !!input.allowCrossOrgInvoice,
      agentOwnerRecheck:
        opts.invocation?.channel === "agent"
          ? { actor, invocation: opts.invocation, orderIds: touchedOrderIds }
          : undefined,
    });

    return {
      invoice: {
        id: result.invoice.id,
        orderId: result.invoice.orderId ?? input.mainOrderId,
        buyerOrganizationName: result.invoice.buyerOrganizationName,
        totalAmount: result.invoice.totalAmount,
        status: result.invoice.status,
      },
      coveredOrderCount: result.coveredOrderCount,
    };
  } catch (err) {
    mapInvoiceRequestWriteError(err);
  }
}
