/**
 * Canonical actor-aware order invoice list query (T6.2).
 *
 * Shared by `GET /api/finance/order-invoices`. Scoped actors only see invoices
 * whose touched orders are entirely in scope (same rule as payment match).
 */
import type { BusinessActor } from "@/lib/application/actor";
import { ForbiddenError } from "@/lib/application/errors";
import { resolveInvoiceTouchedOrderIds } from "@/lib/finance/order-invoice-access";
import {
  classifyTouchedOrderScope,
  loadScopedOrderIdSetForActor,
} from "@/lib/finance/application/invoice-order-scope";
import { assertFinanceInvoiceReadAccess } from "@/lib/finance/application/query-invoice-detail";
import { prisma } from "@/lib/prisma";

export type OrderInvoiceListInput = {
  search?: string;
  status?: string;
  hasRedAdjustment?: "" | "true" | "false";
  missingActualInvoiceNo?: "" | "true";
  orderId?: string;
  page: number;
  pageSize: number;
};

export type OrderInvoiceListItem = {
  id: string;
  status: string;
  invoiceType: string;
  buyerOrganizationName: string;
  /** 票面金额，单位：分 */
  totalAmount: number;
  actualInvoiceNo: string | null;
  actualIssuedAt: Date | null;
  createdAt: Date;
  createdBy: { id: string; name: string | null } | null;
  order: { id: string; orderNo: string } | null;
  orderCoverage: Array<{
    amount: number;
    order: { id: string; orderNo: string };
  }>;
  items: Array<{ itemName: string; amount: number; sortOrder: number }>;
  documents: Array<{ id: string }>;
  adjustmentsAsOriginal: Array<{ id: string; kind: string }>;
};

export type OrderInvoiceListResult = {
  invoices: OrderInvoiceListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

async function getScopedOrderIdsForList(
  scopedSet: Set<string>,
): Promise<string[]> {
  if (scopedSet.size === 1 && scopedSet.has("__NO_MATCH__")) {
    return ["__NO_MATCH__"];
  }
  return [...scopedSet];
}

async function buildListWhere(
  input: OrderInvoiceListInput,
  scopedSet: Set<string> | null,
): Promise<Record<string, unknown>> {
  const andConditions: Record<string, unknown>[] = [];

  if (scopedSet) {
    const scopedIds = await getScopedOrderIdsForList(scopedSet);
    const legacyIds = await prisma.order
      .findMany({
        where: { id: { in: scopedIds }, legacyExternalOrderId: { not: null } },
        select: { legacyExternalOrderId: true },
      })
      .then((rows) => rows.map((r) => r.legacyExternalOrderId!).filter(Boolean));
    andConditions.push({
      OR: [
        { orderId: { in: scopedIds } },
        { orderCoverage: { some: { orderId: { in: scopedIds } } } },
        ...(legacyIds.length > 0 ? [{ externalOrderId: { in: legacyIds } }] : []),
        ...(legacyIds.length > 0
          ? [{ coverage: { some: { externalOrderId: { in: legacyIds } } } }]
          : []),
      ],
    });
  }

  if (input.orderId) {
    const order = await prisma.order.findUnique({
      where: { id: input.orderId },
      select: { legacyExternalOrderId: true },
    });
    const legacyExtId = order?.legacyExternalOrderId ?? null;
    const orConditions: Record<string, unknown>[] = [
      { orderId: input.orderId },
      { orderCoverage: { some: { orderId: input.orderId } } },
    ];
    if (legacyExtId) {
      orConditions.push({ externalOrderId: legacyExtId });
      orConditions.push({ coverage: { some: { externalOrderId: legacyExtId } } });
    }
    andConditions.push({ OR: orConditions });
  }

  if (input.status) andConditions.push({ status: input.status });

  if (input.hasRedAdjustment === "true") {
    andConditions.push({ adjustmentsAsOriginal: { some: { kind: "RED" } } });
  } else if (input.hasRedAdjustment === "false") {
    andConditions.push({ adjustmentsAsOriginal: { none: { kind: "RED" } } });
  }

  if (input.missingActualInvoiceNo === "true") {
    andConditions.push({ status: "ISSUED", actualInvoiceNo: null });
  }

  if (input.search) {
    andConditions.push({
      OR: [
        { buyerOrganizationName: { contains: input.search } },
        { contentSummary: { contains: input.search } },
        { contactName: { contains: input.search } },
        { order: { orderNo: { contains: input.search } } },
        { orderCoverage: { some: { order: { orderNo: { contains: input.search } } } } },
        { actualInvoiceNo: { contains: input.search } },
      ],
    });
  }

  return andConditions.length === 1 ? andConditions[0] : { AND: andConditions };
}

const listSelect = {
  id: true,
  status: true,
  invoiceType: true,
  buyerOrganizationName: true,
  totalAmount: true,
  actualInvoiceNo: true,
  actualIssuedAt: true,
  createdAt: true,
  orderId: true,
  createdBy: { select: { id: true, name: true } },
  order: { select: { id: true, orderNo: true } },
  orderCoverage: {
    select: { amount: true, orderId: true, order: { select: { id: true, orderNo: true } } },
  },
  items: { orderBy: { sortOrder: "asc" as const }, select: { itemName: true, amount: true, sortOrder: true } },
  documents: { select: { id: true } },
  adjustmentsAsOriginal: { select: { id: true, kind: true } },
};

type ListCandidate = Awaited<
  ReturnType<
    typeof prisma.externalOrderInvoiceRequest.findMany<{ select: typeof listSelect }>
  >
>[number];

async function filterToFullScopeInvoices(
  candidates: ListCandidate[],
  scopedSet: Set<string> | null,
): Promise<ListCandidate[]> {
  if (!scopedSet) return candidates;

  const filtered: ListCandidate[] = [];
  for (const inv of candidates) {
    const touched = await resolveInvoiceTouchedOrderIds(inv.id);
    if (classifyTouchedOrderScope(touched, scopedSet) === "full") {
      filtered.push(inv);
    }
  }
  return filtered;
}

export async function queryOrderInvoicesForActor(
  actor: BusinessActor,
  input: OrderInvoiceListInput,
): Promise<OrderInvoiceListResult> {
  assertFinanceInvoiceReadAccess(actor);

  const scopedSet = await loadScopedOrderIdSetForActor(actor);
  const where = await buildListWhere(input, scopedSet);

  const allCandidates = await prisma.externalOrderInvoiceRequest.findMany({
    where,
    select: listSelect,
    orderBy: { createdAt: "desc" },
  });

  const fullScope = await filterToFullScopeInvoices(allCandidates, scopedSet);
  const total = fullScope.length;
  const page = input.page;
  const pageSize = input.pageSize;
  const pageSlice = fullScope.slice((page - 1) * pageSize, page * pageSize);

  return {
    invoices: pageSlice.map((inv) => ({
      id: inv.id,
      status: inv.status,
      invoiceType: inv.invoiceType,
      buyerOrganizationName: inv.buyerOrganizationName,
      totalAmount: inv.totalAmount,
      actualInvoiceNo: inv.actualInvoiceNo,
      actualIssuedAt: inv.actualIssuedAt,
      createdAt: inv.createdAt,
      createdBy: inv.createdBy,
      order: inv.order,
      orderCoverage: inv.orderCoverage.map((c) => ({
        amount: c.amount,
        order: c.order,
      })),
      items: inv.items,
      documents: inv.documents,
      adjustmentsAsOriginal: inv.adjustmentsAsOriginal,
    })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

/** Guard for routes that block finance entirely (e.g. REPRESENTATIVE). */
export function assertOrderInvoiceListRouteRole(role: string): void {
  if (role !== "ADMIN" && role !== "USER" && role !== "REGIONAL_MANAGER") {
    throw new ForbiddenError();
  }
}
