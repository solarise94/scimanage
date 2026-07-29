/**
 * Canonical actor-aware invoice detail query (T6.2).
 *
 * Shared by `GET /api/finance/order-invoices/[id]` and Agent
 * `finance.get_invoice_detail`. Requires full touched-order scope for
 * detailed disclosure; partial/none scope → NotFound (no ID/amount leak).
 */
import type { BusinessActor } from "@/lib/application/actor";
import { ForbiddenError, NotFoundError } from "@/lib/application/errors";
import { loadInvoiceOutstandingAmounts } from "@/lib/finance/invoice-outstanding";
import { getOrderInvoiceOccupancy } from "@/lib/finance/order-invoice-amounts";
import { resolveInvoiceTouchedOrderIds } from "@/lib/finance/order-invoice-access";
import {
  getFinanceProfileScopeWhere,
  getFinanceProjectScopeWhere,
  canReadFinance,
} from "@/lib/finance/permissions";
import { prisma } from "@/lib/prisma";
import {
  classifyInvoiceScopeForActor,
  loadScopedOrderIdSetForActor,
} from "@/lib/finance/application/invoice-order-scope";

export function assertFinanceInvoiceReadAccess(actor: BusinessActor): void {
  if (!canReadFinance(actor.role)) {
    throw new ForbiddenError();
  }
}

export type InvoiceDetailLineItem = {
  itemName: string;
  spec: string | null;
  unit: string | null;
  quantity: number | null;
  /** 金额，单位：分 */
  amount: number;
  sortOrder: number;
};

export type InvoiceDetailCoverage = {
  orderId: string;
  orderNo: string;
  title: string;
  /** 分摊金额，单位：分 */
  amount: number;
};

export type InvoiceDetailOrderQuota = {
  orderId: string;
  orderNo: string | null;
  /** 容量 / 已占用 / 剩余，单位：分 */
  capacity: number;
  occupied: number;
  remaining: number;
  activeInvoices: Array<{
    invoiceId: string;
    status: string;
    amountCents: number;
    source: string;
  }>;
};

export type InvoiceDetailFull = {
  disclosure: "FULL";
  invoice: {
    id: string;
    status: string;
    invoiceType: string;
    buyerOrganizationName: string;
    buyerTaxId: string | null;
    buyerOrganizationId: string | null;
    contactName: string | null;
    sellerName: string | null;
    sellerTaxId: string | null;
    contentSummary: string | null;
    remark: string | null;
    /** 票面金额，单位：分 */
    totalAmount: number;
    actualInvoiceNo: string | null;
    actualIssuedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    order: { id: string; orderNo: string } | null;
    externalOrder: { id: string; externalOrderNo: string } | null;
    createdBy: { id: string; name: string | null } | null;
    documents: Array<{
      id: string;
      fileName: string | null;
      fileUrl: string | null;
      createdAt: Date;
      uploadedBy: { id: string; name: string | null } | null;
    }>;
    receipts: Array<{
      id: string;
      amount: number;
      receivedAt: Date | null;
    }>;
    legacyCoverage: Array<{
      externalOrder: { id: string; externalOrderNo: string } | null;
    }>;
  };
  lineItems: InvoiceDetailLineItem[];
  coveredOrders: InvoiceDetailCoverage[];
  /** 已核销金额，单位：分 */
  allocatedAmount: number;
  /** 剩余可核销，单位：分 */
  outstandingAmount: number;
  orderQuota: InvoiceDetailOrderQuota[];
};

const PARTIAL_SCOPE_MESSAGE =
  "发票关联的订单未全部在当前可见范围内，无法披露票面、分摊或核销详情";

export type InvoiceResourceKind = "order_invoice" | "project_invoice";

/** Lightweight invoice resource fields for Agent resolver (T6.7). */
export type InvoiceResourceForActor = {
  id: string;
  kind: InvoiceResourceKind;
  title: string;
  href: string;
};

/**
 * Resolve invoice href/title for Agent resource navigation.
 * Order invoices require full touched-order scope; partial/none → NotFound.
 * Project invoices use finance project/profile scope with the same non-leak rule.
 */
export async function getInvoiceResourceForActor(
  actor: BusinessActor,
  invoiceId: string,
): Promise<InvoiceResourceForActor> {
  assertFinanceInvoiceReadAccess(actor);

  const orderInvoice = await prisma.externalOrderInvoiceRequest.findUnique({
    where: { id: invoiceId },
    select: {
      id: true,
      buyerOrganizationName: true,
      actualInvoiceNo: true,
    },
  });

  if (orderInvoice) {
    const scopedSet = await loadScopedOrderIdSetForActor(actor);
    const scopeClass = await classifyInvoiceScopeForActor(actor, invoiceId, scopedSet);
    if (scopeClass !== "full") {
      throw new NotFoundError("Not found");
    }
    const title =
      orderInvoice.actualInvoiceNo?.trim() ||
      orderInvoice.buyerOrganizationName?.trim() ||
      "订单发票";
    return {
      id: orderInvoice.id,
      kind: "order_invoice",
      title,
      href: `/finance/invoices?invoiceId=${orderInvoice.id}`,
    };
  }

  const projectInvoice = await prisma.projectInvoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true,
      projectId: true,
      buyerOrganizationName: true,
      project: { select: { id: true, profileId: true } },
    },
  });

  if (!projectInvoice) {
    throw new NotFoundError("Not found");
  }

  if (actor.role !== "ADMIN") {
    const [custScope, projScope] = await Promise.all([
      getFinanceProfileScopeWhere(actor.userId, actor.role),
      getFinanceProjectScopeWhere(actor.userId, actor.role),
    ]);
    if (projScope && !projScope.id.in.includes(projectInvoice.project.id)) {
      throw new NotFoundError("Not found");
    }
    if (
      custScope &&
      projectInvoice.project.profileId &&
      !custScope.id.in.includes(projectInvoice.project.profileId)
    ) {
      throw new NotFoundError("Not found");
    }
  }

  const title = projectInvoice.buyerOrganizationName?.trim() || "项目发票";
  return {
    id: projectInvoice.id,
    kind: "project_invoice",
    title,
    href: `/finance/project-invoices?projectId=${encodeURIComponent(projectInvoice.projectId)}`,
  };
}

export async function getInvoiceDetailForActor(
  actor: BusinessActor,
  invoiceId: string,
): Promise<InvoiceDetailFull> {
  assertFinanceInvoiceReadAccess(actor);

  const invoice = await prisma.externalOrderInvoiceRequest.findUnique({
    where: { id: invoiceId },
    include: {
      items: { orderBy: { sortOrder: "asc" } },
      createdBy: { select: { id: true, name: true } },
      order: { select: { id: true, orderNo: true, title: true } },
      externalOrder: { select: { id: true, externalOrderNo: true } },
      orderCoverage: {
        select: {
          amount: true,
          orderId: true,
          order: { select: { id: true, orderNo: true, title: true } },
        },
      },
      coverage: {
        include: { externalOrder: { select: { id: true, externalOrderNo: true } } },
      },
      documents: {
        include: { uploadedBy: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
      },
      receipts: { where: { deleted: false }, select: { id: true, amount: true, receivedAt: true } },
    },
  });

  if (!invoice) {
    throw new NotFoundError("Not found");
  }

  const scopedSet = await loadScopedOrderIdSetForActor(actor);
  const scopeClass = await classifyInvoiceScopeForActor(actor, invoiceId, scopedSet);
  if (scopeClass !== "full") {
    throw new NotFoundError(PARTIAL_SCOPE_MESSAGE);
  }

  const outstandingMap = await loadInvoiceOutstandingAmounts([
    { id: invoice.id, totalAmount: invoice.totalAmount },
  ]);
  const outstandingAmount = outstandingMap.get(invoice.id) || 0;
  const allocatedAmount = Math.max(invoice.totalAmount - outstandingAmount, 0);

  const touchedOrderIds = await resolveInvoiceTouchedOrderIds(invoiceId);
  const orderQuota: InvoiceDetailOrderQuota[] = [];
  for (const oid of touchedOrderIds) {
    const occ = await getOrderInvoiceOccupancy(oid, { activeOnly: true });
    const o = await prisma.order.findUnique({ where: { id: oid }, select: { orderNo: true } });
    orderQuota.push({
      orderId: oid,
      orderNo: o?.orderNo ?? null,
      capacity: occ.capacity,
      occupied: occ.occupied,
      remaining: occ.remaining,
      activeInvoices: occ.rows,
    });
  }

  return {
    disclosure: "FULL",
    invoice: {
      id: invoice.id,
      status: invoice.status,
      invoiceType: invoice.invoiceType,
      buyerOrganizationName: invoice.buyerOrganizationName,
      buyerTaxId: invoice.buyerTaxId,
      buyerOrganizationId: invoice.buyerOrganizationId,
      contactName: invoice.contactName,
      sellerName: invoice.sellerName,
      sellerTaxId: invoice.sellerTaxId,
      contentSummary: invoice.contentSummary,
      remark: invoice.remark,
      totalAmount: invoice.totalAmount,
      actualInvoiceNo: invoice.actualInvoiceNo,
      actualIssuedAt: invoice.actualIssuedAt,
      createdAt: invoice.createdAt,
      updatedAt: invoice.updatedAt,
      order: invoice.order ? { id: invoice.order.id, orderNo: invoice.order.orderNo } : null,
      externalOrder: invoice.externalOrder,
      createdBy: invoice.createdBy,
      documents: invoice.documents.map((d) => ({
        id: d.id,
        fileName: d.fileName,
        fileUrl: d.fileUrl,
        createdAt: d.createdAt,
        uploadedBy: d.uploadedBy,
      })),
      receipts: invoice.receipts,
      legacyCoverage: invoice.coverage.map((c) => ({
        externalOrder: c.externalOrder,
      })),
    },
    lineItems: invoice.items.map((item) => ({
      itemName: item.itemName,
      spec: item.spec,
      unit: item.unit,
      quantity: item.quantity,
      amount: item.amount,
      sortOrder: item.sortOrder,
    })),
    coveredOrders: invoice.orderCoverage.map((cov) => ({
      orderId: cov.orderId,
      orderNo: cov.order.orderNo,
      title: cov.order.title,
      amount: cov.amount,
    })),
    allocatedAmount,
    outstandingAmount,
    orderQuota,
  };
}

/** Agent adapter: map canonical full detail to compact tool output. */
export function shapeInvoiceDetailForAgent(detail: InvoiceDetailFull): {
  invoice: {
    id: string;
    status: string;
    totalAmount: number;
    buyerOrganizationName: string;
    invoiceType: string;
    actualInvoiceNo: string | null;
  };
  lineItems: Array<{ itemName: string; amount: number }>;
  coveredOrders: Array<{ orderId: string; orderNo: string; title: string; amount: number }>;
  allocatedAmount: number;
  outstandingAmount: number;
} {
  return {
    invoice: {
      id: detail.invoice.id,
      status: detail.invoice.status,
      totalAmount: detail.invoice.totalAmount,
      buyerOrganizationName: detail.invoice.buyerOrganizationName,
      invoiceType: detail.invoice.invoiceType,
      actualInvoiceNo: detail.invoice.actualInvoiceNo,
    },
    lineItems: detail.lineItems.map((item) => ({
      itemName: item.itemName,
      amount: item.amount,
    })),
    coveredOrders: detail.coveredOrders.map((cov) => ({
      orderId: cov.orderId,
      orderNo: cov.orderNo,
      title: cov.title,
      amount: cov.amount,
    })),
    allocatedAmount: detail.allocatedAmount,
    outstandingAmount: detail.outstandingAmount,
  };
}
