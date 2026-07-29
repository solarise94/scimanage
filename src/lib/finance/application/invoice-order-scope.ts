/**
 * Shared invoice ↔ order scope classification (T6.1/T6.2).
 * Used by payment match, invoice detail and list queries.
 */
import type { BusinessActor } from "@/lib/application/actor";
import { NotFoundError } from "@/lib/application/errors";
import { prisma } from "@/lib/prisma";
import { resolveInvoiceTouchedOrderIds } from "@/lib/finance/order-invoice-access";
import { getOrderScopeWhere } from "@/lib/orders/permissions";

export type InvoiceScopeClassification = "full" | "partial" | "none";

export async function loadScopedOrderIdSetForActor(
  actor: BusinessActor,
): Promise<Set<string> | null> {
  const orderScope = await getOrderScopeWhere(actor.userId, actor.role, prisma, actor.department);
  if (!orderScope) return null;

  const scopedOrders = await prisma.order.findMany({
    where: orderScope,
    select: { id: true },
  });
  const set = new Set(scopedOrders.map((o) => o.id));
  if (set.size === 0) {
    set.add("__NO_MATCH__");
  }
  return set;
}

export function classifyTouchedOrderScope(
  touchedOrderIds: string[],
  scopedOrderIdSet: Set<string> | null,
): InvoiceScopeClassification {
  if (touchedOrderIds.length === 0) return "none";
  if (scopedOrderIdSet === null) return "full";

  let inScope = 0;
  for (const id of touchedOrderIds) {
    if (scopedOrderIdSet.has(id)) inScope++;
  }
  if (inScope === 0) return "none";
  if (inScope === touchedOrderIds.length) return "full";
  return "partial";
}

export async function classifyInvoiceScopeForActor(
  actor: BusinessActor,
  invoiceId: string,
  scopedOrderIdSet?: Set<string> | null,
): Promise<InvoiceScopeClassification> {
  const scopedSet =
    scopedOrderIdSet === undefined
      ? await loadScopedOrderIdSetForActor(actor)
      : scopedOrderIdSet;
  const touchedOrderIds = await resolveInvoiceTouchedOrderIds(invoiceId);
  return classifyTouchedOrderScope(touchedOrderIds, scopedSet);
}

export function collectTouchedOrderIdsFromRow(inv: {
  orderId: string | null;
  orderCoverage: Array<{ orderId: string }>;
}): string[] {
  const ids = new Set<string>();
  if (inv.orderId) ids.add(inv.orderId);
  for (const cov of inv.orderCoverage) {
    ids.add(cov.orderId);
  }
  return [...ids];
}

const PARTIAL_ORDER_SCOPE_MESSAGE =
  "订单未全部在当前可见范围内，无法执行开票申请";

/** T6.3: plan/submit/prepare require full visibility of all touched orders. */
export async function assertFullOrderScopeForActor(
  actor: BusinessActor,
  touchedOrderIds: string[],
): Promise<void> {
  if (touchedOrderIds.length === 0) {
    throw new NotFoundError(PARTIAL_ORDER_SCOPE_MESSAGE);
  }
  const scopedSet = await loadScopedOrderIdSetForActor(actor);
  const classification = classifyTouchedOrderScope(touchedOrderIds, scopedSet);
  if (classification !== "full") {
    throw new NotFoundError(PARTIAL_ORDER_SCOPE_MESSAGE);
  }
}

export function classifySingleOrderScope(
  orderId: string,
  scopedOrderIdSet: Set<string> | null,
): InvoiceScopeClassification {
  return classifyTouchedOrderScope([orderId], scopedOrderIdSet);
}
