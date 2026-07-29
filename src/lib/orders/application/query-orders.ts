/**
 * Canonical actor-aware order list/search query service (T2.1).
 *
 * Both the `GET /api/orders` page route and the `orders.search` /
 * `orders.list_pending_receipts` Agent actions call these exports so that
 * capability gate, object scope, deleted/archived/accrual口径, filters,
 * AND-composition, sorting, pagination and totals live in ONE place.
 *
 * This module intentionally lives under `src/lib/orders/application/**`
 * (a canonical service boundary), so direct Prisma access here is allowed;
 * Agent adapters must not re-implement any of this.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import { ForbiddenError } from "@/lib/application/errors";
import { getOrderScopeWhere, isOrderAccessBlocked } from "@/lib/orders/permissions";
import { parseDateRange } from "@/lib/orders/date-range";
import { computeOrderFinanceAmount } from "@/lib/finance/progress";
import { getOrderReceiptTotals } from "@/lib/finance/order-receivables";

/**
 * Capability gate shared by every order read service. Throws ForbiddenError
 * (403) when the caller's role may not access orders at all.
 */
export function assertOrderReadAccess(actor: BusinessActor): void {
  if (isOrderAccessBlocked(actor.role)) {
    throw new ForbiddenError("无权访问订单");
  }
}

/** Rich list select — superset that satisfies both the page and Agent DTOs. */
export const ORDER_LIST_SELECT = {
  id: true, orderNo: true, source: true, sourcePlatform: true, sourceRemark: true, externalOrderNo: true,
  title: true, category: true, status: true,
  orderedAt: true, confirmedAt: true, deliveredAt: true,
  profileId: true,
  profile: {
    select: {
      id: true,
      name: true,
      customerCode: true,
      organization: true,
      organizationId: true,
      org: { select: { canonicalName: true } },
      orgSite: { select: { siteName: true } },
    },
  },
  buyerNameSnapshot: true, buyerPhoneSnapshot: true, buyerWechatSnapshot: true, buyerOrgNameSnapshot: true, buyerAddressSnapshot: true,
  buyerOrganizationId: true,
  buyerOrganization: { select: { id: true, canonicalName: true } },
  customerMatchStatus: true, customerMatchScore: true, customerMatchReason: true,
  totalAmount: true, financeAmountOverride: true, financeTreatment: true, financeNote: true,
  ownerUserId: true, techSupport: true, representativeId: true,
  representative: { select: { id: true, name: true } },
  createdById: true, createdAt: true, updatedAt: true,
  projectLinks: { select: { id: true, treatment: true, allocatedAmount: true, isPrimary: true, project: { select: { id: true, name: true, techSupport: true } } } },
  mergeSources: { select: { targetOrderId: true } },
  invoiceRequests: { where: { status: { not: "CANCELLED" } }, select: { status: true } },
  invoiceCoverage: { where: { invoiceRequest: { status: { not: "CANCELLED" } } }, select: { invoiceRequest: { select: { status: true } } } },
  sourceRecords: { select: { duplicateStatus: true }, take: 1, orderBy: { createdAt: "desc" } },
  _count: { select: { lines: true, receipts: { where: { deleted: false } } } },
} satisfies Prisma.OrderSelect;

export type OrderListRecord = Prisma.OrderGetPayload<{ select: typeof ORDER_LIST_SELECT }>;

export type OrderListFilters = {
  search?: string | null;
  source?: string | null;
  status?: string | null;
  category?: string | null;
  customerMatchStatus?: string | null;
  financeTreatment?: string | null;
  profileId?: string | null;
  projectId?: string | null;
  representativeId?: string | null;
  createdFrom?: string | null;
  createdTo?: string | null;
  deliveredFrom?: string | null;
  deliveredTo?: string | null;
  /** Include ACCRUAL_REVERSAL shadow orders (default false, matches page). */
  includeAccrual?: boolean;
  /** ADMIN-only recycle-bin visibility (default false). */
  includeDeleted?: boolean;
};

export type OrderListSort = { key?: string | null; dir?: "asc" | "desc" | null };

export type OrderListParams = {
  filters?: OrderListFilters;
  sort?: OrderListSort;
  page?: number;
  pageSize?: number;
};

export type OrderListResult = {
  orders: OrderListRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

/** Whitelisted sort keys → Order column (avoids arbitrary field injection). */
const SORTABLE_MAP: Record<string, { field: string } | null> = {
  orderedAt: { field: "orderedAt" },
  totalAmount: { field: "totalAmount" },
  amount: { field: "totalAmount" },
  orderNo: { field: "orderNo" },
  externalOrderNo: { field: "externalOrderNo" },
  createdAt: { field: "createdAt" },
  "": null,
};

function buildOrderBy(sort?: OrderListSort): Prisma.OrderOrderByWithRelationInput[] {
  const key = (sort?.key ?? "").trim();
  const dir: "asc" | "desc" = sort?.dir === "asc" ? "asc" : "desc";
  const entry = SORTABLE_MAP[key];
  if (entry) {
    return [{ [entry.field]: dir } as Prisma.OrderOrderByWithRelationInput, { createdAt: "desc" }];
  }
  return [{ orderedAt: "desc" }, { createdAt: "desc" }];
}

/**
 * Build the AND-composed order WHERE from actor scope + filters.
 * Scope WHERE and search/filters are merged via `{ AND: [...] }` (AGENTS.md).
 */
async function buildOrderListWhere(
  actor: BusinessActor,
  filters: OrderListFilters,
): Promise<Prisma.OrderWhereInput> {
  const scopeWhere = await getOrderScopeWhere(actor.userId, actor.role, prisma, actor.department);
  const and: Prisma.OrderWhereInput[] = [];

  if (scopeWhere) and.push(scopeWhere as Prisma.OrderWhereInput);

  const search = filters.search?.trim();
  if (search) {
    and.push({
      OR: [
        { orderNo: { contains: search } },
        { externalOrderNo: { contains: search } },
        { title: { contains: search } },
        { buyerNameSnapshot: { contains: search } },
        { buyerPhoneSnapshot: { contains: search } },
        { buyerOrgNameSnapshot: { contains: search } },
        { buyerAddressSnapshot: { contains: search } },
      ],
    });
  }

  const exact: Prisma.OrderWhereInput = {};
  if (filters.source) exact.source = filters.source;
  if (filters.status) exact.status = filters.status;
  if (filters.category) exact.category = filters.category;
  if (filters.customerMatchStatus) exact.customerMatchStatus = filters.customerMatchStatus;
  if (filters.financeTreatment) exact.financeTreatment = filters.financeTreatment;
  if (filters.profileId) exact.profileId = filters.profileId;
  if (filters.representativeId) exact.representativeId = filters.representativeId;
  if (Object.keys(exact).length > 0) and.push(exact);

  if (filters.projectId) and.push({ projectLinks: { some: { projectId: filters.projectId } } });

  const createdRange = parseDateRange(filters.createdFrom ?? undefined, filters.createdTo ?? undefined);
  if (createdRange) and.push({ orderedAt: createdRange });
  const deliveredRange = parseDateRange(filters.deliveredFrom ?? undefined, filters.deliveredTo ?? undefined);
  if (deliveredRange) and.push({ deliveredAt: deliveredRange });

  // deleted 口径：默认排除；仅 ADMIN 显式 includeDeleted 时可见回收站。
  const showDeleted = filters.includeDeleted === true && actor.role === "ADMIN";
  if (!showDeleted) and.push({ deleted: false });

  if (!filters.includeAccrual) and.push({ source: { not: "ACCRUAL_REVERSAL" } });

  return { AND: and };
}

/**
 * List/search orders visible to `actor` with unified filters, sort,
 * pagination and total. Returns rich domain records; adapters map to their DTO.
 */
export async function queryOrders(
  actor: BusinessActor,
  params: OrderListParams = {},
): Promise<OrderListResult> {
  assertOrderReadAccess(actor);

  const page = Math.max(1, Math.floor(params.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(params.pageSize ?? 20)));
  const where = await buildOrderListWhere(actor, params.filters ?? {});
  const orderBy = buildOrderBy(params.sort);

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: ORDER_LIST_SELECT,
    }),
    prisma.order.count({ where }),
  ]);

  return {
    orders,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

/** 待回款扫描：每页候选订单数 / 累计扫描上限（防极端库规模拖垮查询）。 */
const PENDING_RECEIPTS_PAGE_SIZE = 100;
const PENDING_RECEIPTS_MAX_SCAN = 2000;

export type PendingReceiptItem = {
  id: string;
  orderNo: string;
  externalOrderNo: string | null;
  title: string;
  status: string;
  financeAmount: number;
  receivedAmount: number;
  outstandingAmount: number;
  buyerNameSnapshot: string | null;
  buyerOrgNameSnapshot: string | null;
  customerName: string | null;
  orderedAt: string | null;
};

export type PendingReceiptsResult = {
  items: PendingReceiptItem[];
  scanned: number;
  truncated: boolean;
};

/**
 * List orders in scope whose effective finance amount exceeds received amount
 * (CONFIRMED/DELIVERED only), ordered by orderedAt desc. Pagination scans
 * candidate orders until `limit` pending items are collected or the scan cap
 * is reached (then truncated=true).
 */
export async function listPendingReceiptOrders(
  actor: BusinessActor,
  params: { limit: number },
): Promise<PendingReceiptsResult> {
  assertOrderReadAccess(actor);

  const limit = Math.min(30, Math.max(1, Math.floor(params.limit)));
  const scopeWhere = await getOrderScopeWhere(actor.userId, actor.role, prisma, actor.department);
  const where: Prisma.OrderWhereInput = {
    AND: [
      { deleted: false },
      ...(scopeWhere ? [scopeWhere as Prisma.OrderWhereInput] : []),
      { status: { in: ["CONFIRMED", "DELIVERED"] } },
    ],
  };

  const items: PendingReceiptItem[] = [];
  let skip = 0;
  let scanned = 0;
  let truncated = false;

  while (items.length < limit && scanned < PENDING_RECEIPTS_MAX_SCAN) {
    const take = Math.min(PENDING_RECEIPTS_PAGE_SIZE, PENDING_RECEIPTS_MAX_SCAN - scanned);
    const orders = await prisma.order.findMany({
      where,
      orderBy: [{ orderedAt: "desc" }, { createdAt: "desc" }],
      skip,
      take,
      select: {
        id: true,
        orderNo: true,
        externalOrderNo: true,
        title: true,
        status: true,
        totalAmount: true,
        financeAmountOverride: true,
        orderedAt: true,
        buyerNameSnapshot: true,
        buyerOrgNameSnapshot: true,
        profile: { select: { name: true } },
      },
    });
    if (orders.length === 0) break;

    scanned += orders.length;
    skip += orders.length;

    const receiptTotals = await getOrderReceiptTotals(orders.map((o) => o.id));
    for (const order of orders) {
      const financeAmount = computeOrderFinanceAmount({
        totalAmount: order.totalAmount,
        financeAmountOverride: order.financeAmountOverride,
      });
      const receivedAmount = receiptTotals.get(order.id) ?? 0;
      const outstandingAmount = financeAmount - receivedAmount;
      if (outstandingAmount <= 0) continue;
      items.push({
        id: order.id,
        orderNo: order.orderNo,
        externalOrderNo: order.externalOrderNo,
        title: order.title,
        status: order.status,
        financeAmount,
        receivedAmount,
        outstandingAmount,
        buyerNameSnapshot: order.buyerNameSnapshot,
        buyerOrgNameSnapshot: order.buyerOrgNameSnapshot,
        customerName: order.profile?.name ?? null,
        orderedAt: order.orderedAt ? order.orderedAt.toISOString() : null,
      });
      if (items.length >= limit) break;
    }

    if (orders.length < take) break;
    if (items.length < limit && scanned >= PENDING_RECEIPTS_MAX_SCAN) {
      truncated = true;
    }
  }

  return { items: items.slice(0, limit), scanned, truncated };
}
