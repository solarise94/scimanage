/**
 * Phase B: canonical actor-aware order-receivables query service（修正 8）。
 *
 * 抽取自原 /api/finance/order-receivables route handler，**完整承接** Web 全量口径：
 * 6 view（all|uninvoiced|invoiceable|invoiced_unpaid|paid|no_customer）、search、
 * profileId、representativeId、invoiceSub/receiptSub、分页、aggregate。Web route 改调
 * 此 service，行为字节级不变（回归测试守护）。
 *
 * Agent find_orders.financialView 是该 service 的受控子集：
 *  - any → view=all 精简投影
 *  - pending_receipt → 复用 listPendingReceiptOrders 口径
 *  - settled → view=paid 精简投影
 * Agent 不暴露 sub-filter/aggregate。
 *
 * scope AND-composition、deleted 口径、occupancy 去重（RED/REISSUE/软删除回款/allocation/
 * legacy）全部复用既有 helper，绝不复制 Prisma 查询。
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import { ForbiddenError } from "@/lib/application/errors";
import { getOrderScopeWhere } from "@/lib/orders/permissions";
import {
  getOrderReceiptTotals,
  getGlobalInvoiceTotal,
  getGlobalReceiptTotal,
} from "@/lib/finance/order-receivables";
import {
  getOrderInvoiceSummaryBatch,
  isOrderInvoiceable,
  isOrderSettled,
  yuanAmountToCents,
  type OrderInvoiceSummary,
} from "@/lib/finance/order-invoice-amounts";
import { centsToYuan } from "@/lib/finance/money";

export type ReceivablesView =
  | "all"
  | "uninvoiced"
  | "invoiceable"
  | "invoiced_unpaid"
  | "paid"
  | "no_customer";

export type InvoiceSub = "none" | "partial" | null;
export type ReceiptSub = "zero" | "partial" | null;

const ORDER_SELECT = {
  id: true,
  orderNo: true,
  title: true,
  totalAmount: true,
  orderedAt: true,
  status: true,
  profileId: true,
  profile: { select: { id: true, name: true, customerCode: true } },
} as const;

const EMPTY_SUMMARY: OrderInvoiceSummary = {
  invoiceCount: 0,
  invoiceStatusSummary: {},
  invoiceCapacityAmount: 0,
  invoicedAmount: 0,
  invoiceRequestedAmount: 0,
  invoiceDraftAmount: 0,
  invoiceOccupiedAmount: 0,
  invoiceRemainingAmount: 0,
};

export interface OrderReceivablesRow {
  id: string;
  orderNo: string;
  title: string | null;
  profile: { id: string; name: string | null } | null;
  totalAmount: number;
  invoiceCapacityAmount: number;
  invoicedAmount: number;
  invoiceDraftAmount: number;
  invoiceRequestedAmount: number;
  invoiceRemainingAmount: number;
  receivedAmount: number;
  unpaidAmount: number;
  orderedAt: string | null;
  status: string;
}

export interface OrderReceivablesAggregate {
  totalAmount: number;
  invoiceTotal: number;
  receiptTotal: number;
  unpaidTotal: number;
  uninvoicedTotal: number;
  /** remainingTotal 仅 occupancy-filtered view 返回（all/no_customer 不返回）。 */
  remainingTotal?: number;
}

export interface OrderReceivablesResult {
  orders: OrderReceivablesRow[];
  aggregate: OrderReceivablesAggregate;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface OrderReceivablesQuery {
  search?: string;
  profileId?: string;
  representativeId?: string;
  view: ReceivablesView;
  /** 兼容旧深链：uninvoiced → invoiceable + invoiceSub=none。 */
  invoiceSub?: InvoiceSub;
  receiptSub?: ReceiptSub;
  page?: number;
  pageSize?: number;
}

function assertReadAccess(actor: BusinessActor): void {
  const role = actor.role;
  if (
    role !== "ADMIN" &&
    role !== "USER" &&
    role !== "REPRESENTATIVE" &&
    role !== "REGIONAL_MANAGER"
  ) {
    throw new ForbiddenError("无权访问订单应收");
  }
}

function mapOrderRow(
  o: {
    id: string;
    orderNo: string;
    title: string | null;
    totalAmount: number;
    orderedAt: Date | null;
    status: string;
    profileId: string | null;
    profile: { id: string; name: string | null; customerCode: string | null } | null;
  },
  summary: OrderInvoiceSummary,
  receivedCents: number,
): OrderReceivablesRow {
  const issuedCents = yuanAmountToCents(summary.invoicedAmount);
  return {
    id: o.id,
    orderNo: o.orderNo,
    title: o.title,
    profile: o.profile ? { id: o.profile.id, name: o.profile.name ?? null } : null,
    totalAmount: centsToYuan(o.totalAmount),
    invoiceCapacityAmount: summary.invoiceCapacityAmount,
    invoicedAmount: summary.invoicedAmount,
    invoiceDraftAmount: summary.invoiceDraftAmount,
    invoiceRequestedAmount: summary.invoiceRequestedAmount,
    invoiceRemainingAmount: summary.invoiceRemainingAmount,
    receivedAmount: centsToYuan(receivedCents),
    unpaidAmount: centsToYuan(Math.max(issuedCents - receivedCents, 0)),
    orderedAt: o.orderedAt?.toISOString() ?? null,
    status: o.status,
  };
}

/**
 * 主查询入口。Web route 与 Agent facade 共用。
 *
 * 行为与原 route handler 字节级一致（回归测试守护）：
 *  - scope WHERE + search/profileId/representativeId/status(no_customer) + deleted AND-composition；
 *  - view=all|no_customer 走 lightweight aggregate（含 PROJECT_INCLUDED/EXCLUDED）；
 *  - view=invoiceable|invoiced_unpaid|paid 走 occupancy 过滤（满载 + eligibleIds 分页）；
 *  - uninvoiced 兼容 → invoiceable + invoiceSub=none；
 *  - aggregate 字段集与原 route 一致（all/no_customer 不返回 remainingTotal）。
 */
export async function queryOrderReceivables(
  actor: BusinessActor,
  params: OrderReceivablesQuery,
): Promise<OrderReceivablesResult> {
  assertReadAccess(actor);

  const search = params.search?.trim() || "";
  const profileId = params.profileId?.trim() || "";
  const representativeId = params.representativeId?.trim() || "";
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(params.pageSize ?? 50)));

  let view = params.view;
  let invoiceSub: InvoiceSub = params.invoiceSub ?? null;
  // 兼容旧深链：uninvoiced → invoiceable + invoiceSub=none
  if (view === "uninvoiced") {
    view = "invoiceable";
    if (!invoiceSub) invoiceSub = "none";
  }
  const receiptSub: ReceiptSub = params.receiptSub ?? null;
  const isNoCustomerView = view === "no_customer";

  const scopeWhere = await getOrderScopeWhere(actor.userId, actor.role, prisma, actor.department);

  const andConditions: Record<string, unknown>[] = [];
  if (scopeWhere) andConditions.push(scopeWhere);

  if (search) {
    andConditions.push({
      OR: [
        { orderNo: { contains: search } },
        { title: { contains: search } },
        { buyerNameSnapshot: { contains: search } },
        { buyerOrgNameSnapshot: { contains: search } },
      ],
    });
  }
  if (profileId) andConditions.push({ profileId });
  if (representativeId) andConditions.push({ representativeId });

  if (isNoCustomerView) {
    andConditions.push({
      profileId: null,
      status: { in: ["CONFIRMED", "CLOSED"] },
      source: { not: "ACCRUAL_REVERSAL" },
    });
  }

  andConditions.push({ deleted: false });

  const where: Record<string, unknown> =
    andConditions.length === 1 ? andConditions[0] : { AND: andConditions };

  // ── view=all / no_customer: lightweight aggregate ──
  if (view === "all" || view === "no_customer") {
    const scopedOrderIds = (await prisma.order.findMany({ where, select: { id: true } })).map(
      (o) => o.id,
    );

    const [totalAgg, count, invoiceTotal, receiptTotal] = await Promise.all([
      prisma.order.aggregate({ where, _sum: { totalAmount: true } }),
      prisma.order.count({ where }),
      getGlobalInvoiceTotal(scopedOrderIds),
      getGlobalReceiptTotal(scopedOrderIds),
    ]);
    const aggregate: OrderReceivablesAggregate = {
      totalAmount: totalAgg._sum.totalAmount ?? 0,
      invoiceTotal,
      receiptTotal,
      unpaidTotal: Math.max(invoiceTotal - receiptTotal, 0),
      uninvoicedTotal: Math.max((totalAgg._sum.totalAmount ?? 0) - invoiceTotal, 0),
    };

    const total = count;
    const totalPages = Math.ceil(total / pageSize);
    const skip = (page - 1) * pageSize;

    const orders =
      total > 0
        ? await prisma.order.findMany({
            where,
            select: ORDER_SELECT,
            orderBy: [{ orderedAt: "desc" }, { createdAt: "desc" }],
            skip,
            take: pageSize,
          })
        : [];

    const pageIds = orders.map((o) => o.id);
    const [pageSummaries, pageReceiptTotals] =
      pageIds.length > 0
        ? await Promise.all([
            getOrderInvoiceSummaryBatch(pageIds),
            getOrderReceiptTotals(pageIds),
          ])
        : [new Map<string, OrderInvoiceSummary>(), new Map<string, number>()];

    const result = orders.map((o) =>
      mapOrderRow(o, pageSummaries.get(o.id) ?? EMPTY_SUMMARY, pageReceiptTotals.get(o.id) || 0),
    );

    return {
      orders: result,
      aggregate: {
        totalAmount: centsToYuan(aggregate.totalAmount),
        invoiceTotal: centsToYuan(aggregate.invoiceTotal),
        receiptTotal: centsToYuan(aggregate.receiptTotal),
        unpaidTotal: centsToYuan(aggregate.unpaidTotal),
        uninvoicedTotal: centsToYuan(aggregate.uninvoicedTotal),
      },
      total,
      page,
      pageSize,
      totalPages,
    };
  }

  // ── view=invoiceable / invoiced_unpaid / paid：occupancy 过滤 ──
  const allOrdersForAggregate = await prisma.order.findMany({
    where,
    select: { id: true, totalAmount: true, orderedAt: true, createdAt: true, profileId: true },
    orderBy: [{ orderedAt: "desc" }, { createdAt: "desc" }],
  });

  const allIds = allOrdersForAggregate.map((o) => o.id);
  const [allSummaries, allReceiptTotals] = await Promise.all([
    getOrderInvoiceSummaryBatch(allIds),
    getOrderReceiptTotals(allIds),
  ]);

  const orderProfileMap = new Map(allOrdersForAggregate.map((o) => [o.id, o.profileId]));

  const eligibleIds = allIds.filter((id) => {
    const summary = allSummaries.get(id) ?? EMPTY_SUMMARY;
    const receivedCents = allReceiptTotals.get(id) || 0;
    const receivedYuan = centsToYuan(receivedCents);
    const issuedCents = yuanAmountToCents(summary.invoicedAmount);
    const unpaidCents = Math.max(issuedCents - receivedCents, 0);
    const profileIdVal = orderProfileMap.get(id);

    switch (view) {
      case "invoiceable": {
        if (!isOrderInvoiceable({ profileId: profileIdVal, remainingYuan: summary.invoiceRemainingAmount })) {
          return false;
        }
        if (invoiceSub === "none") return issuedCents <= 0;
        if (invoiceSub === "partial") return issuedCents > 0;
        return true;
      }
      case "invoiced_unpaid": {
        if (profileIdVal == null || issuedCents <= 0 || unpaidCents <= 0) return false;
        if (receiptSub === "zero") return receivedCents <= 0;
        if (receiptSub === "partial") return receivedCents > 0 && unpaidCents > 0;
        return true;
      }
      case "paid":
        return isOrderSettled({
          profileId: profileIdVal,
          capacityYuan: summary.invoiceCapacityAmount,
          issuedYuan: summary.invoicedAmount,
          draftYuan: summary.invoiceDraftAmount,
          requestedYuan: summary.invoiceRequestedAmount,
          receivedYuan,
        });
      default:
        return true;
    }
  });

  const total = eligibleIds.length;
  const totalPages = Math.ceil(total / pageSize);
  const pageIds = eligibleIds.slice((page - 1) * pageSize, page * pageSize);

  const orders =
    pageIds.length > 0
      ? await prisma.order.findMany({
          where: { id: { in: pageIds } },
          select: ORDER_SELECT,
          orderBy: [{ orderedAt: "desc" }, { createdAt: "desc" }],
        })
      : [];

  const eligibleOrderMap = new Map(allOrdersForAggregate.map((o) => [o.id, o]));
  let aggregateTotalAmount = 0;
  let aggregateInvoiceTotal = 0;
  let aggregateReceiptTotal = 0;
  let aggregateRemaining = 0;
  for (const id of eligibleIds) {
    aggregateTotalAmount += eligibleOrderMap.get(id)?.totalAmount || 0;
    const summary = allSummaries.get(id) ?? EMPTY_SUMMARY;
    aggregateInvoiceTotal += yuanAmountToCents(summary.invoicedAmount);
    aggregateReceiptTotal += allReceiptTotals.get(id) || 0;
    aggregateRemaining += yuanAmountToCents(summary.invoiceRemainingAmount);
  }

  const orderMap = new Map(orders.map((o) => [o.id, o]));
  const result = pageIds.flatMap((id) => {
    const o = orderMap.get(id);
    if (!o) return [];
    return [mapOrderRow(o, allSummaries.get(id) ?? EMPTY_SUMMARY, allReceiptTotals.get(id) || 0)];
  });

  return {
    orders: result,
    aggregate: {
      totalAmount: centsToYuan(aggregateTotalAmount),
      invoiceTotal: centsToYuan(aggregateInvoiceTotal),
      receiptTotal: centsToYuan(aggregateReceiptTotal),
      unpaidTotal: centsToYuan(Math.max(aggregateInvoiceTotal - aggregateReceiptTotal, 0)),
      uninvoicedTotal: centsToYuan(Math.max(aggregateTotalAmount - aggregateInvoiceTotal, 0)),
      remainingTotal: centsToYuan(aggregateRemaining),
    },
    total,
    page,
    pageSize,
    totalPages,
  };
}

/** 保留 Prisma 类型引用，避免未使用 import（canonical service 允许 Prisma）。 */
export type { Prisma };
