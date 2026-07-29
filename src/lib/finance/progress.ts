import { prisma } from "@/lib/prisma";
import { isProductProject } from "./types";
import { collectByChunks } from "./query-chunk";
import { roundForDisplay } from "./money";
import { centsToYuan } from "./money";
import { getBusinessDayWindow, getBusinessMonthWindow, getBusinessWeekWindow, getShanghaiParts, shanghaiWallTimeToUtc } from "@/lib/business-time";

export { isProductProject } from "./types";

// ─── Date helpers ──────────────────────────────────────────────

export function getWeekRange(nowInput: Date = new Date()): { start: Date; end: Date } {
  const { start } = getBusinessWeekWindow(nowInput);
  const { end } = getBusinessDayWindow(nowInput);
  return { start, end: new Date(end.getTime() - 1) };
}

export function getMonthRange(nowInput: Date = new Date()): { start: Date; end: Date } {
  const { start } = getBusinessMonthWindow(nowInput);
  const { end } = getBusinessDayWindow(nowInput);
  return { start, end: new Date(end.getTime() - 1) };
}

export function getQuarterRange(nowInput: Date = new Date()): { start: Date; end: Date } {
  const now = getShanghaiParts(nowInput);
  const quarterStartMonth = Math.floor((now.month - 1) / 3) * 3 + 1;
  const start = shanghaiWallTimeToUtc({ year: now.year, month: quarterStartMonth, day: 1 });
  const { end } = getBusinessDayWindow(nowInput);
  return { start, end: new Date(end.getTime() - 1) };
}

export function getYearRange(nowInput: Date = new Date()): { start: Date; end: Date } {
  const now = getShanghaiParts(nowInput);
  const start = shanghaiWallTimeToUtc({ year: now.year, month: 1, day: 1 });
  const { end } = getBusinessDayWindow(nowInput);
  return { start, end: new Date(end.getTime() - 1) };
}

export function getPeriodKeys(period: string, range: { start: Date; end: Date }): string[] {
  const monthKey = (date: Date) => {
    const p = getShanghaiParts(date);
    return `${p.year}-${String(p.month).padStart(2, "0")}`;
  };
  if (period === "quarter") {
    const start = getShanghaiParts(range.start);
    const end = getShanghaiParts(range.end);
    const keys: string[] = [];
    let year = start.year;
    let month = start.month;
    while (year < end.year || (year === end.year && month <= end.month)) {
      keys.push(`${year}-${String(month).padStart(2, "0")}`);
      month += 1;
      if (month === 13) {
        month = 1;
        year += 1;
      }
    }
    return keys;
  }
  if (period === "week") {
    const startKey = monthKey(range.start);
    const endKey = monthKey(range.end);
    return startKey === endKey ? [startKey] : [startKey, endKey];
  }
  return [monthKey(range.start)];
}

// ─── Project date resolution ──────────────────────────────────

export function getProjectStartDate(project: {
  startDate: Date | string | null;
  createdAt: Date | string;
}): Date {
  if (project.startDate) return new Date(project.startDate);
  return new Date(project.createdAt);
}

export function getProjectCompletionDate(project: {
  id: string;
  endDate: Date | string | null;
  status: string;
}): Date | null {
  return project.endDate ? new Date(project.endDate) : null;
}

export async function resolveProjectCompletionDate(project: {
  id: string;
  endDate: Date | string | null;
  status: string;
  statusHistory?: Array<{ newStatus: string; createdAt: Date | string }>;
}): Promise<Date | null> {
  if (project.statusHistory) {
    const completed = project.statusHistory.find((h) => h.newStatus === "COMPLETED");
    if (completed) return new Date(completed.createdAt);
  } else if (project.status === "COMPLETED") {
    const sh = await prisma.statusHistory.findFirst({
      where: { projectId: project.id, newStatus: "COMPLETED" },
      orderBy: { createdAt: "desc" },
    });
    if (sh) return new Date(sh.createdAt);
  }
  if (project.endDate) return new Date(project.endDate);
  return null;
}

// ─── Order date resolution (unified Order model) ──────────────

export function getOrderDate(order: {
  orderedAt: Date | string | null;
  confirmedAt: Date | string | null;
  createdAt: Date | string;
}): Date {
  if (order.orderedAt) return new Date(order.orderedAt);
  if (order.confirmedAt) return new Date(order.confirmedAt);
  return new Date(order.createdAt);
}

// ─── Order finance helpers (unified Order model) ───────────────

export type FinanceCategory = "UNKNOWN" | "PRODUCT" | "SERVICE";
export type FinanceTreatment = "AUTO" | "STANDALONE" | "PROJECT_INCLUDED" | "EXCLUDED";

export function computeOrderFinanceAmount(order: {
  totalAmount: number;
  financeAmountOverride: number | null;
}): number {
  if (order.financeAmountOverride != null) return order.financeAmountOverride;
  return order.totalAmount ?? 0;
}

/**
 * Derive effective finance treatment for an order.
 * When financeTreatment is AUTO, fall back to whether the order has any
 * OrderProjectLink, so that orders bound to projects auto-include.
 */
export function getOrderEffectiveTreatment(
  financeTreatment: string,
  hasProjectLinks: boolean,
): FinanceTreatment {
  if (financeTreatment !== "AUTO") return financeTreatment as FinanceTreatment;
  return hasProjectLinks ? "PROJECT_INCLUDED" : "STANDALONE";
}

export function isOrderStandalone(financeTreatment: string, hasProjectLinks: boolean): boolean {
  return getOrderEffectiveTreatment(financeTreatment, hasProjectLinks) === "STANDALONE";
}

export function isOrderProjectLinked(financeTreatment: string, hasProjectLinks: boolean): boolean {
  return getOrderEffectiveTreatment(financeTreatment, hasProjectLinks) === "PROJECT_INCLUDED";
}

// ─── Progress receivable computation ───────────────────────────

export interface ProgressReceivableResult {
  total: number;
  serviceDeposit: number;
  serviceFinal: number;
  productReceivable: number;
}

export function computeProjectProgressReceivable(
  project: {
    budgetAmount: number | null;
    projectType: string | null;
    startDate: Date | string | null;
    createdAt: Date | string;
    completionDate: Date | null;
  },
  periodStart: Date,
  periodEnd: Date,
): ProgressReceivableResult {
  const budget = project.budgetAmount ?? 0;
  const startDate = getProjectStartDate(project);
  const startedInPeriod = startDate >= periodStart && startDate <= periodEnd;
  const completedInPeriod = project.completionDate
    ? project.completionDate >= periodStart && project.completionDate <= periodEnd
    : false;

  let serviceDeposit = 0;
  let serviceFinal = 0;
  let productReceivable = 0;

  const budgetYuan = centsToYuan(budget);
  if (isProductProject(project.projectType)) {
    if (startedInPeriod) productReceivable = budgetYuan;
  } else {
    if (startedInPeriod && completedInPeriod) {
      serviceDeposit = roundForDisplay(budgetYuan * 0.3);
      serviceFinal = roundForDisplay(budgetYuan * 0.7);
    } else if (startedInPeriod) {
      serviceDeposit = roundForDisplay(budgetYuan * 0.3);
    } else if (completedInPeriod) {
      serviceFinal = roundForDisplay(budgetYuan * 0.7);
    }
  }

  return { total: serviceDeposit + serviceFinal + productReceivable, serviceDeposit, serviceFinal, productReceivable };
}

export function computeStandaloneOrderReceivable(
  order: {
    totalAmount: number;
    financeAmountOverride: number | null;
    category: string;
    financeTreatment: string;
    hasProjectLinks: boolean;
    orderedAt: Date | string | null;
    confirmedAt: Date | string | null;
    createdAt: Date | string;
  },
  periodStart: Date,
  periodEnd: Date,
): number {
  const treatment = getOrderEffectiveTreatment(order.financeTreatment, order.hasProjectLinks);
  if (treatment === "PROJECT_INCLUDED" || treatment === "EXCLUDED") return 0;

  const orderDate = getOrderDate(order);
  if (orderDate < periodStart || orderDate > periodEnd) return 0;

  const amount = computeOrderFinanceAmount(order);
  const amountYuan = centsToYuan(amount);
  if (order.category === "PRODUCT") return amountYuan;
  return roundForDisplay(amountYuan * 0.3);
}

export async function computeAllProgressReceivables(
  projects: Array<{
    id: string;
    budgetAmount: number | null;
    projectType: string | null;
    startDate: Date | string | null;
    createdAt: Date | string;
    endDate: Date | string | null;
    status: string;
  }>,
  orders: Array<{
    totalAmount: number;
    financeAmountOverride: number | null;
    category: string;
    financeTreatment: string;
    hasProjectLinks: boolean;
    orderedAt: Date | string | null;
    confirmedAt: Date | string | null;
    createdAt: Date | string;
  }>,
  scopedOrderIds?: string[],
  scopedProjectIds?: string[],
): Promise<{
  weekProject: ProgressReceivableResult;
  monthProject: ProgressReceivableResult;
  weekOrder: number;
  monthOrder: number;
}> {
  const week = getWeekRange();
  const month = getMonthRange();

  let weekProject: ProgressReceivableResult = { total: 0, serviceDeposit: 0, serviceFinal: 0, productReceivable: 0 };
  let monthProject: ProgressReceivableResult = { total: 0, serviceDeposit: 0, serviceFinal: 0, productReceivable: 0 };

  for (const p of projects) {
    const completionDate = await resolveProjectCompletionDate(p);
    const wp = computeProjectProgressReceivable({ ...p, completionDate }, week.start, week.end);
    const mp = computeProjectProgressReceivable({ ...p, completionDate }, month.start, month.end);
    weekProject = {
      total: weekProject.total + wp.total,
      serviceDeposit: weekProject.serviceDeposit + wp.serviceDeposit,
      serviceFinal: weekProject.serviceFinal + wp.serviceFinal,
      productReceivable: weekProject.productReceivable + wp.productReceivable,
    };
    monthProject = {
      total: monthProject.total + mp.total,
      serviceDeposit: monthProject.serviceDeposit + mp.serviceDeposit,
      serviceFinal: monthProject.serviceFinal + mp.serviceFinal,
      productReceivable: monthProject.productReceivable + mp.productReceivable,
    };
  }

  let weekOrder = 0;
  let monthOrder = 0;
  for (const o of orders) {
    weekOrder += computeStandaloneOrderReceivable(o, week.start, week.end);
    monthOrder += computeStandaloneOrderReceivable(o, month.start, month.end);
  }

  // Add revision adjustments for the periods (按 periodKey 月份口径，与明细页保持一致)
  const weekPeriodKeys = getPeriodKeys("week", week);
  const monthPeriodKeys = getPeriodKeys("month", month);
  const [weekAdjustmentRows, monthAdjustmentRows] = await Promise.all([
    fetchProgressAdjustmentsByScope({ periodKey: { in: weekPeriodKeys } }, scopedOrderIds, scopedProjectIds),
    fetchProgressAdjustmentsByScope({ periodKey: { in: monthPeriodKeys } }, scopedOrderIds, scopedProjectIds),
  ]);
  weekOrder += weekAdjustmentRows.reduce((sum, a) => sum + a.amount, 0);
  monthOrder += monthAdjustmentRows.reduce((sum, a) => sum + a.amount, 0);

  return { weekProject, monthProject, weekOrder, monthOrder };
}

export type ProgressAdjustmentRow = {
  id: string;
  orderId: string | null;
  projectId: string | null;
  profileId: string | null;
  amount: number;
  category: string;
  reason: string | null;
  periodKey: string;
  sourceId: string;
  sourceType: string;
  occurredAt: Date;
};

export async function fetchProgressAdjustmentsByScope(
  where: Record<string, unknown>,
  scopedOrderIds?: string[],
  scopedProjectIds?: string[],
): Promise<ProgressAdjustmentRow[]> {
  if (scopedOrderIds !== undefined || scopedProjectIds !== undefined) {
    if ((scopedOrderIds?.length ?? 0) === 0 && (scopedProjectIds?.length ?? 0) === 0) {
      return [];
    }

    const seen = new Set<string>();
    const result: ProgressAdjustmentRow[] = [];
    const pushUnique = (rows: ProgressAdjustmentRow[]) => {
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        result.push(row);
      }
    };

    if (scopedOrderIds?.length) {
      const orderRows = await collectByChunks(scopedOrderIds, (chunk) =>
        prisma.progressReceivableAdjustment.findMany({
          where: { ...where, orderId: { in: chunk } },
          select: {
            id: true,
            orderId: true,
            projectId: true,
            profileId: true,
            amount: true,
            category: true,
            reason: true,
            periodKey: true,
            sourceId: true,
            sourceType: true,
            occurredAt: true,
          },
          orderBy: { occurredAt: "desc" },
        })
      );
      pushUnique(orderRows);
    }

    if (scopedProjectIds?.length) {
      const projectRows = await collectByChunks(scopedProjectIds, (chunk) =>
        prisma.progressReceivableAdjustment.findMany({
          where: { ...where, projectId: { in: chunk } },
          select: {
            id: true,
            orderId: true,
            projectId: true,
            profileId: true,
            amount: true,
            category: true,
            reason: true,
            periodKey: true,
            sourceId: true,
            sourceType: true,
            occurredAt: true,
          },
          orderBy: { occurredAt: "desc" },
        })
      );
      pushUnique(projectRows);
    }

    result.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
    return result;
  }

  return prisma.progressReceivableAdjustment.findMany({
    where,
    select: {
      id: true,
      orderId: true,
      projectId: true,
      profileId: true,
      amount: true,
      category: true,
      reason: true,
      periodKey: true,
      sourceId: true,
      sourceType: true,
      occurredAt: true,
    },
    orderBy: { occurredAt: "desc" },
  });
}

// ─── Revision adjustment helpers ──────────────────────────────────
//
// 调整项统一按 periodKey 月份口径查询；调用方直接用 fetchProgressAdjustmentsByScope
// 构造 { periodKey: { in: periodKeys } }，不再提供按 occurredAt 日期范围的包装函数。

