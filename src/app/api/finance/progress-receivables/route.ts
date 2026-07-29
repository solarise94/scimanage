import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { isFinanceBlocked, getFinanceProfileScopeWhere, getFinanceProjectScopeWhere } from "@/lib/finance/permissions";
import { prisma } from "@/lib/prisma";
import { isProductProject } from "@/lib/finance/types";
import {
  getProjectStartDate,
  getOrderDate,
  getOrderEffectiveTreatment,
  computeOrderFinanceAmount,
  resolveProjectCompletionDate,
  getWeekRange,
  getMonthRange,
  getQuarterRange,
  getPeriodKeys,
  fetchProgressAdjustmentsByScope,
} from "@/lib/finance/progress";
import { getProjectTypeLabel } from "@/lib/project-type";
import { centsToYuan, roundForDisplay } from "@/lib/finance/money";

export async function GET(req: NextRequest) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (isFinanceBlocked(session.user.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = req.nextUrl;
  const period = url.searchParams.get("period") || "week";
  const range = period === "month"
    ? getMonthRange()
    : period === "quarter"
      ? getQuarterRange()
      : getWeekRange();

  // Phase 0 review #5：财务聚合排除治理桶。
  const projectWhere: Record<string, unknown> = { deleted: false, systemType: "NORMAL" };
  if (session.user.role !== "ADMIN") {
    const projScope = await getFinanceProjectScopeWhere(session.user.id, session.user.role);
    if (projScope) projectWhere.id = projScope.id;
  }

  const profileScope = await getFinanceProfileScopeWhere(session.user.id, session.user.role);

  const allProjects = await prisma.project.findMany({
    where: projectWhere,
    select: {
      id: true, name: true, budgetAmount: true, projectType: true,
      startDate: true, createdAt: true, endDate: true, status: true,
      profile: { select: { id: true, name: true } },
    },
  });

  // Order scope: customerScope OR projectScope→linked orders
  const orderOrConditions: Record<string, unknown>[] = [];
  if (profileScope) {
    orderOrConditions.push({ profileId: profileScope.id });
  }
  if (session.user.role !== "ADMIN") {
    const projScope = await getFinanceProjectScopeWhere(session.user.id, session.user.role);
    if (projScope) {
      const projectOrders = await prisma.orderProjectLink.findMany({
        where: { projectId: { in: projScope.id.in } },
        select: { orderId: true },
        distinct: ["orderId"],
      });
      if (projectOrders.length > 0) orderOrConditions.push({ id: { in: projectOrders.map((l) => l.orderId) } });
    }
  }
  const orderWhere: Record<string, unknown> = { deleted: false };
  if (orderOrConditions.length === 1) Object.assign(orderWhere, orderOrConditions[0]);
  else if (orderOrConditions.length > 1) orderWhere.OR = orderOrConditions;

  const allOrders = await prisma.order.findMany({
    where: orderWhere,
    select: {
      id: true, orderNo: true, totalAmount: true,
      category: true, financeTreatment: true, financeAmountOverride: true,
      orderedAt: true, confirmedAt: true, createdAt: true,
      profile: { select: { id: true, name: true } },
    },
  });

  // Pre-fetch project links for AUTO resolution
  const orderIds = allOrders.map((o) => o.id);
  const linkMap = new Map<string, boolean>();
  if (orderIds.length > 0) {
    const links = await prisma.orderProjectLink.findMany({
      where: { orderId: { in: orderIds } },
      select: { orderId: true },
      distinct: ["orderId"],
    });
    for (const l of links) linkMap.set(l.orderId, true);
  }

  const projectItems: Array<Record<string, unknown>> = [];
  const orderItems: Array<Record<string, unknown>> = [];

  let totalServiceDeposit = 0;
  let totalServiceFinal = 0;
  let totalProductReceivable = 0;

  for (const p of allProjects) {
    const budgetYuan = centsToYuan(p.budgetAmount ?? 0);
    const startDate = getProjectStartDate(p);
    const completionDate = await resolveProjectCompletionDate(p);
    const startedIn = startDate >= range.start && startDate <= range.end;
    const completedIn = completionDate ? completionDate >= range.start && completionDate <= range.end : false;
    const isProduct = isProductProject(p.projectType);

    if (isProduct) {
      if (startedIn) {
        totalProductReceivable += budgetYuan;
        projectItems.push({
          projectId: p.id, projectName: p.name, customerName: p.profile?.name || "",
          projectType: getProjectTypeLabel(p.projectType),
          eventType: "PRODUCT_START", eventDate: startDate.toISOString(),
          budgetAmount: roundForDisplay(budgetYuan), receivableAmount: roundForDisplay(budgetYuan), rate: 1,
        });
      }
    } else {
      if (startedIn) {
        totalServiceDeposit += budgetYuan * 0.3;
        projectItems.push({
          projectId: p.id, projectName: p.name, customerName: p.profile?.name || "",
          projectType: getProjectTypeLabel(p.projectType),
          eventType: "SERVICE_START", eventDate: startDate.toISOString(),
          budgetAmount: roundForDisplay(budgetYuan), receivableAmount: roundForDisplay(budgetYuan * 0.3), rate: 0.3,
        });
      }
      if (completedIn) {
        totalServiceFinal += budgetYuan * 0.7;
        projectItems.push({
          projectId: p.id, projectName: p.name, customerName: p.profile?.name || "",
          projectType: getProjectTypeLabel(p.projectType),
          eventType: "SERVICE_COMPLETED", eventDate: (completionDate || new Date()).toISOString(),
          budgetAmount: roundForDisplay(budgetYuan), receivableAmount: roundForDisplay(budgetYuan * 0.7), rate: 0.7,
        });
      }
    }
  }

  let orderDepositTotal = 0;
  let orderProductTotal = 0;

  for (const o of allOrders) {
    const treatment = getOrderEffectiveTreatment(o.financeTreatment, linkMap.has(o.id));
    if (treatment !== "STANDALONE") continue;
    const orderDate = getOrderDate(o);
    if (orderDate < range.start || orderDate > range.end) continue;
    const amountYuan = centsToYuan(computeOrderFinanceAmount(o));
    const cat = o.category;
    if (cat === "PRODUCT") {
      orderProductTotal += amountYuan;
      orderItems.push({
        orderId: o.id, orderNo: o.orderNo,
        customerName: o.profile?.name || "",
        financeCategory: cat,
        eventType: "PRODUCT_ORDER", eventDate: orderDate.toISOString(),
        amount: roundForDisplay(amountYuan), receivableAmount: roundForDisplay(amountYuan), rate: 1,
      });
    } else {
      orderDepositTotal += amountYuan * 0.3;
      orderItems.push({
        orderId: o.id, orderNo: o.orderNo,
        customerName: o.profile?.name || "",
        financeCategory: cat,
        eventType: "SERVICE_ORDER_DEPOSIT", eventDate: orderDate.toISOString(),
        amount: roundForDisplay(amountYuan), receivableAmount: roundForDisplay(amountYuan * 0.3), rate: 0.3,
      });
    }
  }

  const periodKeys = getPeriodKeys(period, range);

  // Build scope lists for adjustment filtering
  const scopedOrderIds = session.user.role !== "ADMIN" ? orderIds : undefined;
  const scopedProjectIds = session.user.role !== "ADMIN" ? allProjects.map((p) => p.id) : undefined;

  const adjustmentItems = await fetchProgressAdjustmentsByScope(
    { periodKey: { in: periodKeys } },
    scopedOrderIds,
    scopedProjectIds,
  );
  const adjustmentAmount = adjustmentItems.reduce((sum, a) => sum + a.amount, 0);

  // Enrich adjustment items with order/project names
  const adjustmentOrderIds = [...new Set(adjustmentItems.map((a) => a.orderId).filter(Boolean))] as string[];
  const adjustmentProjectIds = [...new Set(adjustmentItems.map((a) => a.projectId).filter(Boolean))] as string[];

  const [adjOrders, adjProjects] = await Promise.all([
    adjustmentOrderIds.length > 0
      ? prisma.order.findMany({ where: { id: { in: adjustmentOrderIds } }, select: { id: true, orderNo: true } })
      : [],
    adjustmentProjectIds.length > 0
      ? prisma.project.findMany({ where: { id: { in: adjustmentProjectIds } }, select: { id: true, name: true } })
      : [],
  ]);

  const orderMap = new Map(adjOrders.map((o) => [o.id, o.orderNo]));
  const projectMap = new Map(adjProjects.map((p) => [p.id, p.name]));

  const adjustmentRows = adjustmentItems.map((a) => ({
    type: "ORDER_REVISION_ADJUSTMENT",
    orderId: a.orderId,
    projectId: a.projectId,
    orderNo: a.orderId ? (orderMap.get(a.orderId) || null) : null,
    projectName: a.projectId ? (projectMap.get(a.projectId) || null) : null,
    amount: a.amount,
    periodKey: a.periodKey,
    reason: a.reason,
    revisionId: a.sourceId,
  }));

  return NextResponse.json({
    period,
    total: roundForDisplay(totalServiceDeposit + totalServiceFinal + totalProductReceivable + orderDepositTotal + orderProductTotal + adjustmentAmount),
    adjustmentAmount: roundForDisplay(adjustmentAmount),
    adjustmentItems: adjustmentRows,
    serviceDeposit: roundForDisplay(totalServiceDeposit),
    serviceFinal: roundForDisplay(totalServiceFinal),
    productReceivable: roundForDisplay(totalProductReceivable),
    projectItems,
    orderItems,
  });
}
