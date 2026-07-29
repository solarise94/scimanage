/**
 * Canonical actor-aware submit invoice request command (T6.3).
 *
 * Shared by Agent `finance.submit_invoice_request`. Creates REQUESTED with
 * strict buyer validation. All touched orders must be fully in actor scope.
 */
import type { BusinessActor, InvocationContext } from "@/lib/application/actor";
import { NotFoundError, ValidationError } from "@/lib/application/errors";
import { getOrderInvoiceOccupancy } from "@/lib/finance/order-invoice-amounts";
import { validateTouchedOrders } from "@/lib/finance/order-invoices";
import {
  createOrderInvoiceRequest,
  resolveInvoiceBuyerSnapshot,
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

export type SubmitInvoiceRequestCommandInput = {
  projectId?: string | null;
  mainOrderId: string;
  coverageAllocations: InvoiceCoverageCommandInput[];
  sellerProfileId: string;
  buyerOrganizationId: string;
  buyerOrganizationName: string;
  invoiceType: "NORMAL" | "SPECIAL";
  contactName?: string | null;
  contentSummary?: string | null;
  remark?: string | null;
  items: InvoiceRequestItemCommandInput[];
  sourceAgentProposalId?: string | null;
};

export type SubmitInvoiceRequestPreview = {
  title: string;
  summary: string;
  target: { type: "order"; id: string };
  proposalInput: Record<string, unknown>;
};

export type SubmitInvoiceRequestResult = {
  invoice: {
    id: string;
    orderId: string;
    buyerOrganizationName: string;
    totalAmount: number;
    status: string;
  };
  coveredOrderCount: number;
  idempotentHit: boolean;
};

function normalizeItems(items: InvoiceRequestItemCommandInput[]) {
  return items.filter((item) => item.itemName.trim());
}

export async function previewSubmitInvoiceRequestForActor(
  actor: BusinessActor,
  input: SubmitInvoiceRequestCommandInput,
): Promise<SubmitInvoiceRequestPreview> {
  assertAdminInvoiceRequestWrite(actor);

  const mainOrder = await prisma.order.findUnique({
    where: { id: input.mainOrderId, deleted: false },
    select: { id: true, orderNo: true, title: true },
  });
  if (!mainOrder) {
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
    allowCrossOrgInvoice: false,
    allowProjectIncludedInvoice: false,
  });
  if (!validation.ok) {
    throw new ValidationError(String(validation.body.error || validation.body.message || "开票前置校验失败"));
  }

  let resolvedBuyerName = input.buyerOrganizationName;
  const resolved = await resolveInvoiceBuyerSnapshot(
    prisma,
    {
      mainOrderId: input.mainOrderId,
      coverageAllocations: input.coverageAllocations,
      buyerOrganizationId: input.buyerOrganizationId,
      buyerOrganizationName: input.buyerOrganizationName,
      invoiceType: input.invoiceType,
      items: itemRows,
      targetStatus: "REQUESTED",
      createdById: actor.userId,
      strictBuyerOrg: true,
    },
    touchedOrderIds,
  );
  resolvedBuyerName = resolved.buyerOrganizationName;

  let sellerName: string | null = null;
  if (input.sellerProfileId) {
    const profile = await prisma.billingProfile.findUnique({
      where: { id: input.sellerProfileId },
      select: { name: true, archived: true },
    });
    if (!profile || profile.archived) {
      throw new ValidationError("销方主体不存在或已归档");
    }
    sellerName = profile.name;
  }

  let projectName: string | null = null;
  if (input.projectId) {
    const project = await prisma.project.findUnique({
      where: { id: input.projectId },
      select: { name: true },
    });
    projectName = project?.name ?? null;
  }

  const remainingByOrder: Record<string, number> = {};
  for (const orderId of touchedOrderIds) {
    const occupancy = await getOrderInvoiceOccupancy(orderId, { activeOnly: true });
    remainingByOrder[orderId] = occupancy.remaining;
  }

  const coveredOrders = await prisma.order.findMany({
    where: { id: { in: input.coverageAllocations.map((row) => row.orderId) } },
    select: { id: true, orderNo: true, title: true },
  });
  const orderById = new Map(coveredOrders.map((order) => [order.id, order]));
  const orderLabels = input.coverageAllocations.map((row) => {
    const order = orderById.get(row.orderId);
    return order ? `${order.orderNo} · ${order.title}` : row.orderId.slice(-6);
  });

  return {
    title: `提交开票申请：${mainOrder.orderNo || mainOrder.id.slice(-6)}`,
    summary: [
      projectName ? `项目「${projectName}」` : null,
      `购方「${resolvedBuyerName}」`,
      sellerName ? `销方「${sellerName}」` : null,
      input.invoiceType === "SPECIAL" ? "专票" : "普票",
      `金额 ${(totalAmountCents / 100).toFixed(2)} 元`,
      `覆盖 ${input.coverageAllocations.length} 笔订单`,
      "确认后将直接提交为待开票（REQUESTED）",
    ]
      .filter(Boolean)
      .join("，"),
    target: { type: "order", id: mainOrder.id },
    proposalInput: {
      ...input,
      buyerOrganizationName: resolvedBuyerName,
      projectName,
      mainOrderNo: mainOrder.orderNo,
      orderLabels,
      sellerName,
      totalAmountCents,
      coverageDetails: input.coverageAllocations,
      remainingByOrder,
    },
  };
}

export async function submitInvoiceRequestForActor(
  actor: BusinessActor,
  input: SubmitInvoiceRequestCommandInput,
  opts: { invocation?: InvocationContext } = {},
): Promise<SubmitInvoiceRequestResult> {
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

  // Phase E（P0-3）：Agent 项目开票 submit——early pre-check + 最终写事务内复核。
  if (opts.invocation?.channel === "agent") {
    const { assertAgentCanWriteOrders } = await import("@/lib/orders/application/technical-owner-gate");
    await assertAgentCanWriteOrders(actor, opts.invocation, touchedOrderIds);
  }

  try {
    const result: CreateOrderInvoiceRequestResult = await createOrderInvoiceRequest({
      mainOrderId: input.mainOrderId,
      coverageAllocations: input.coverageAllocations,
      buyerOrganizationId: input.buyerOrganizationId,
      buyerOrganizationName: input.buyerOrganizationName,
      sellerProfileId: input.sellerProfileId,
      invoiceType: input.invoiceType,
      contactName: input.contactName,
      contentSummary: input.contentSummary,
      remark: input.remark,
      items: itemRows,
      targetStatus: "REQUESTED",
      createdById: actor.userId,
      sourceAgentProposalId: input.sourceAgentProposalId ?? null,
      allowCrossOrgInvoice: false,
      strictBuyerOrg: true,
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
      idempotentHit: result.idempotentHit,
    };
  } catch (err) {
    mapInvoiceRequestWriteError(err);
  }
}
