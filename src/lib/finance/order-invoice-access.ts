import { prisma } from "@/lib/prisma";
import { getOrderScopeWhere } from "@/lib/orders/permissions";
import {
  getFinanceProfileScopeWhere,
  getFinanceProjectScopeWhere,
} from "@/lib/finance/permissions";

/**
 * Resolve all Order IDs that an invoice touches, including:
 * - direct orderId
 * - orderCoverage orderIds
 * - legacy externalOrderId (resolved back to Order.id)
 * - legacy coverage externalOrderIds (resolved back to Order.id)
 *
 * Returns de-duplicated order ids. May return empty array for orphan invoices.
 */
export async function resolveInvoiceTouchedOrderIds(invoiceId: string): Promise<string[]> {
  const invoice = await prisma.externalOrderInvoiceRequest.findUnique({
    where: { id: invoiceId },
    select: {
      orderId: true,
      externalOrderId: true,
      orderCoverage: { select: { orderId: true } },
      coverage: { select: { externalOrderId: true } },
    },
  });

  if (!invoice) return [];

  const touchedOrderIds: string[] = [
    ...(invoice.orderId ? [invoice.orderId] : []),
    ...invoice.orderCoverage.map((c) => c.orderId),
  ];

  const legacyExtIds = [
    ...(invoice.externalOrderId ? [invoice.externalOrderId] : []),
    ...invoice.coverage.map((c) => c.externalOrderId).filter((id): id is string => !!id),
  ];

  if (legacyExtIds.length > 0) {
    const legacyOrders = await prisma.order.findMany({
      where: { legacyExternalOrderId: { in: legacyExtIds } },
      select: { id: true },
    });
    for (const lo of legacyOrders) touchedOrderIds.push(lo.id);
  }

  return [...new Set(touchedOrderIds)];
}

/**
 * Assert the user can read the given order invoice.
 * Throws a Response-like error object for early return in route handlers.
 *
 * Returns normally if readable. Throws { status, body } if not.
 */
export async function assertOrderInvoiceReadable(
  invoiceId: string,
  userId: string,
  role: string,
  department?: string,
): Promise<void> {
  if (role === "ADMIN") return;

  const orderScope = await getOrderScopeWhere(userId, role, prisma, department);
  const touchedOrderIds = await resolveInvoiceTouchedOrderIds(invoiceId);

  if (touchedOrderIds.length === 0) {
    throw { status: 403, body: { error: "Forbidden" } };
  }

  if (orderScope) {
    const scopedCount = await prisma.order.count({
      where: { AND: [{ id: { in: touchedOrderIds } }, orderScope] },
    });
    if (scopedCount === 0) {
      throw { status: 403, body: { error: "Forbidden" } };
    }
  }
}

/**
 * Assert the user can read a legacy ProjectInvoice via project/profile finance scope.
 * Throws { status, body } if not readable (same shape as assertOrderInvoiceReadable).
 */
export async function assertProjectInvoiceReadable(
  invoiceId: string,
  userId: string,
  role: string,
): Promise<void> {
  if (role === "ADMIN") return;

  const inv = await prisma.projectInvoice.findUnique({
    where: { id: invoiceId },
    select: { project: { select: { profileId: true, id: true } } },
  });
  if (!inv) {
    throw { status: 404, body: { error: "Not found" } };
  }

  const [custScope, projScope] = await Promise.all([
    getFinanceProfileScopeWhere(userId, role),
    getFinanceProjectScopeWhere(userId, role),
  ]);

  if (projScope && !projScope.id.in.includes(inv.project.id)) {
    throw { status: 403, body: { error: "Forbidden" } };
  }
  if (custScope && inv.project.profileId && !custScope.id.in.includes(inv.project.profileId)) {
    throw { status: 403, body: { error: "Forbidden" } };
  }
}

/** True when assertOrderInvoiceReadable would succeed. */
export async function canReadOrderInvoice(
  invoiceId: string,
  userId: string,
  role: string,
  department: string,
): Promise<boolean> {
  try {
    await assertOrderInvoiceReadable(invoiceId, userId, role, department);
    return true;
  } catch (err) {
    if (err && typeof err === "object" && "status" in err) {
      const status = (err as { status?: number }).status;
      if (status === 403 || status === 404) return false;
    }
    throw err;
  }
}

/** True when assertProjectInvoiceReadable would succeed. */
export async function canReadProjectInvoice(
  invoiceId: string,
  userId: string,
  role: string,
): Promise<boolean> {
  try {
    await assertProjectInvoiceReadable(invoiceId, userId, role);
    return true;
  } catch (err) {
    if (err && typeof err === "object" && "status" in err) {
      const status = (err as { status?: number }).status;
      if (status === 403 || status === 404) return false;
    }
    throw err;
  }
}
