/**
 * Canonical actor-aware order detail / finance-snapshot / summary query service (T2.1).
 *
 * Consumed by:
 *  - `GET /api/orders/[id]`          → getOrderDetail
 *  - `GET /api/orders/[id]/summary`  → getOrderSummary
 *  - Agent `orders.get_detail`       → getOrderDetail
 *  - Agent `orders.get_finance_snapshot` → getOrderFinanceSnapshot
 *
 * Object scope, deleted口径, ref resolution (id / orderNo / externalOrderNo) and
 * capability gate live here; Agent adapters must not re-implement them.
 *
 * Disclosure: an out-of-scope or missing order both raise NotFoundError so the
 * service never leaks the existence of orders the actor cannot read. (The legacy
 * page routes returned 403 for out-of-scope, which leaked existence — unified to
 * 404 here per §2.3.)
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import { NotFoundError } from "@/lib/application/errors";
import { getOrderScopeWhere } from "@/lib/orders/permissions";
import { getInvoicesForOrder, type UnifiedOrderInvoice } from "@/lib/finance/order-invoices";
import { getOrderReceiptTotals, getOrderCostTotals } from "@/lib/finance/order-receivables";
import { computeOrderFinanceAmount } from "@/lib/finance/progress";
import { assertOrderReadAccess } from "./query-orders";

/**
 * Resolve a model/route-provided order reference (id, orderNo or externalOrderNo)
 * to the canonical internal id, enforcing the actor's object scope.
 *
 * `includeDeleted` controls whether soft-deleted orders are resolvable; callers
 * pass `actor.role === "ADMIN"` for detail (ADMIN sees deleted, others 404) and
 * `true` for the summary endpoint (in-scope regardless of deleted).
 */
export async function resolveOrderRefForActor(
  actor: BusinessActor,
  ref: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<string> {
  const scope = actor.role === "ADMIN" ? null : await getOrderScopeWhere(actor.userId, actor.role, prisma, actor.department);
  const and: Prisma.OrderWhereInput[] = [
    { OR: [{ id: ref }, { orderNo: ref }, { externalOrderNo: ref }] },
  ];
  if (scope) and.push(scope as Prisma.OrderWhereInput);
  if (!opts.includeDeleted) and.push({ deleted: false });

  const order = await prisma.order.findFirst({
    where: { AND: and },
    select: { id: true },
  });
  if (!order) {
    throw new NotFoundError(
      `找不到订单「${ref}」，或没有查看权限。请先用 orders.search 搜索，再使用返回结果中的 id`,
    );
  }
  return order.id;
}

/**
 * Lightweight order resource location fields for Agent resource resolver (T2.6).
 * Same scope/deleted口径 as detail; does not load lines/finance.
 */
export async function getOrderResourceForActor(
  actor: BusinessActor,
  ref: string,
): Promise<{ id: string; orderNo: string; title: string }> {
  assertOrderReadAccess(actor);
  const id = await resolveOrderRefForActor(actor, ref, {
    includeDeleted: actor.role === "ADMIN",
  });
  const order = await prisma.order.findUnique({
    where: { id },
    select: { id: true, orderNo: true, title: true },
  });
  if (!order) {
    throw new NotFoundError(
      `找不到订单「${ref}」，或没有查看权限。请先用 orders.search 搜索，再使用返回结果中的 id`,
    );
  }
  return order;
}

/** Full detail include — matches the `GET /api/orders/[id]` page baseline. */
export const ORDER_DETAIL_INCLUDE = {
  profile: {
    select: {
      id: true,
      name: true,
      customerCode: true,
      organization: true,
      organizationId: true,
      org: { select: { canonicalName: true } },
    },
  },
  buyerOrganization: { select: { id: true, canonicalName: true } },
  representative: { select: { id: true, name: true } },
  lines: { orderBy: { sortOrder: "asc" } },
  sourceRecords: { orderBy: { createdAt: "desc" } },
  projectLinks: {
    include: {
      project: { select: { id: true, name: true, status: true } },
    },
  },
  statusHistory: { orderBy: { createdAt: "desc" }, take: 50 },
  mergeSources: {
    include: { sourceOrder: { select: { id: true, orderNo: true } } },
  },
  mergeTargets: {
    include: { targetOrder: { select: { id: true, orderNo: true } } },
  },
  accrualReversals: { select: { id: true, orderNo: true } },
  accrualReversalOf: { select: { id: true, orderNo: true } },
  receipts: { where: { deleted: false }, select: { id: true, amount: true, receivedAt: true, source: true, remark: true, createdBy: { select: { name: true } } }, orderBy: { createdAt: "desc" } },
  financeCosts: { select: { id: true, amount: true, costType: true, remark: true, createdAt: true }, take: 20, orderBy: { createdAt: "desc" } },
  _count: { select: { lines: true, sourceRecords: true, projectLinks: true, receipts: { where: { deleted: false } }, invoiceRequests: true, financeCosts: true } },
} satisfies Prisma.OrderInclude;

export type OrderDetailRecord = Prisma.OrderGetPayload<{ include: typeof ORDER_DETAIL_INCLUDE }>;

export type OrderDetailResult = {
  order: OrderDetailRecord;
  invoices: UnifiedOrderInvoice[];
};

/**
 * Load full order detail + unified invoices for `actor`.
 * Accepts an id/orderNo/externalOrderNo ref. Throws NotFoundError when the
 * order does not exist or is outside the actor's scope.
 */
export async function getOrderDetail(actor: BusinessActor, ref: string): Promise<OrderDetailResult> {
  assertOrderReadAccess(actor);
  const orderId = await resolveOrderRefForActor(actor, ref, { includeDeleted: actor.role === "ADMIN" });
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: ORDER_DETAIL_INCLUDE,
  });
  if (!order) throw new NotFoundError(`找不到订单「${ref}」`);
  const invoices = await getInvoicesForOrder(orderId);
  return { order, invoices };
}

export type OrderFinanceSnapshot = {
  order: {
    id: string;
    orderNo: string;
    title: string;
    status: string;
    totalAmount: number;
    financeAmount: number;
  };
  finance: {
    financeAmount: number;
    invoicedAmount: number;
    receiptAmount: number;
    costAmount: number;
    outstandingAmount: number;
  };
  invoiceStatus: string;
  projectLinks: Array<{
    projectId: string;
    projectName: string;
    allocatedAmount: number | null;
    treatment: string;
  }>;
  invoices: Array<{
    id: string;
    status: string;
    totalAmount: number;
    actualInvoiceNo: string | null;
  }>;
};

/**
 * Finance snapshot (amounts, invoices, receipts, cost, project links) for a
 * single order. Same scope/ref rules as detail.
 */
export async function getOrderFinanceSnapshot(
  actor: BusinessActor,
  ref: string,
): Promise<OrderFinanceSnapshot> {
  assertOrderReadAccess(actor);
  const orderId = await resolveOrderRefForActor(actor, ref, { includeDeleted: actor.role === "ADMIN" });

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNo: true,
      title: true,
      status: true,
      totalAmount: true,
      financeAmountOverride: true,
      projectLinks: {
        select: {
          treatment: true,
          allocatedAmount: true,
          project: { select: { id: true, name: true } },
        },
      },
    },
  });
  if (!order) throw new NotFoundError(`找不到订单「${ref}」`);

  const invoices = await getInvoicesForOrder(orderId);
  const receiptTotals = await getOrderReceiptTotals([orderId]);
  const costTotals = await getOrderCostTotals([orderId]);

  const financeAmount = computeOrderFinanceAmount({
    totalAmount: order.totalAmount,
    financeAmountOverride: order.financeAmountOverride,
  });
  const invoicedAmount = invoices
    .filter((inv) => inv.status !== "CANCELLED")
    .reduce((sum, inv) => sum + inv.totalAmount, 0);
  const receiptAmount = receiptTotals.get(orderId) ?? 0;
  const costAmount = costTotals.get(orderId) ?? 0;

  const invoiceStatus = invoices.length === 0
    ? "NONE"
    : invoices.some((inv) => inv.status === "ISSUED")
      ? "ISSUED"
      : invoices.some((inv) => inv.status === "REQUESTED")
        ? "REQUESTED"
        : invoices[0].status;

  return {
    order: {
      id: order.id,
      orderNo: order.orderNo,
      title: order.title,
      status: order.status,
      totalAmount: order.totalAmount,
      financeAmount,
    },
    finance: {
      financeAmount,
      invoicedAmount,
      receiptAmount,
      costAmount,
      outstandingAmount: Math.max(invoicedAmount - receiptAmount, 0),
    },
    invoiceStatus,
    projectLinks: order.projectLinks.map((link) => ({
      projectId: link.project.id,
      projectName: link.project.name,
      allocatedAmount: link.allocatedAmount,
      treatment: link.treatment,
    })),
    invoices: invoices.map((inv) => ({
      id: inv.id,
      status: inv.status,
      totalAmount: inv.totalAmount,
      actualInvoiceNo: inv.actualInvoiceNo,
    })),
  };
}

export type OrderSummary = {
  orderId: string;
  orderNo: string;
  orderAmount: number;
  effectiveAmount: number;
  financeTreatment: string | null;
  category: string;
  status: string;
  receiptAmount: number;
};

/**
 * Lightweight order summary for `GET /api/orders/[id]/summary`.
 * In-scope regardless of deleted (matches page baseline). Amounts in cents;
 * the route maps to yuan.
 */
export async function getOrderSummary(actor: BusinessActor, id: string): Promise<OrderSummary> {
  assertOrderReadAccess(actor);
  const orderId = await resolveOrderRefForActor(actor, id, { includeDeleted: true });

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNo: true,
      totalAmount: true,
      financeAmountOverride: true,
      financeTreatment: true,
      category: true,
      status: true,
    },
  });
  if (!order) throw new NotFoundError(`找不到订单「${id}」`);

  const receiptTotals = await getOrderReceiptTotals([orderId]);
  const receiptAmount = receiptTotals.get(orderId) ?? 0;
  const effectiveAmount = order.financeAmountOverride ?? order.totalAmount;

  return {
    orderId: order.id,
    orderNo: order.orderNo,
    orderAmount: order.totalAmount,
    effectiveAmount,
    financeTreatment: order.financeTreatment,
    category: order.category,
    status: order.status,
    receiptAmount,
  };
}
