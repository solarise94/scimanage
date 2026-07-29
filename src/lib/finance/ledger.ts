import { prisma } from "@/lib/prisma";
import { computeOrderFinanceAmount, getOrderEffectiveTreatment } from "./progress";

// ─── Revenue helpers ─────────────────────────────────────────────

/** Effective amount for a single order: override if set, otherwise totalAmount. */
export function computeOrderRevenueAmount(order: {
  totalAmount: number;
  financeAmountOverride: number | null;
}): number {
  return computeOrderFinanceAmount(order);
}

/**
 * Effective project revenue amount.
 *
 * Priority:
 * 1. project.budgetAmount if explicitly set
 * 2. Sum of PROJECT_INCLUDED / AUTO-linked order amounts
 * 3. Respects OrderProjectLink.allocatedAmount when available
 */
export async function computeProjectRevenueAmount(project: {
  id: string;
  budgetAmount: number | null;
}): Promise<number> {
  if (project.budgetAmount != null && project.budgetAmount > 0) {
    return project.budgetAmount;
  }

  // Fall back to linked project-included orders
  const links = await prisma.orderProjectLink.findMany({
    where: { projectId: project.id },
    select: {
      allocatedAmount: true,
      order: { select: { totalAmount: true, financeAmountOverride: true, financeTreatment: true, deleted: true } },
    },
  });

  let total = 0;
  for (const link of links) {
    if (link.order.deleted) continue;
    const treatment = getOrderEffectiveTreatment(link.order.financeTreatment, true);
    if (treatment !== "PROJECT_INCLUDED") continue;

    if (link.allocatedAmount != null) {
      total += link.allocatedAmount;
    } else {
      total += computeOrderFinanceAmount(link.order);
    }
  }
  return total;
}

/**
 * Compute effective business amount across projects and orders.
 * PROJECT_INCLUDED orders are counted only through their project,
 * preventing double-counting. STANDALONE orders are counted separately.
 */
export async function computeEffectiveBusinessAmount(
  projects: Array<{ id: string; budgetAmount: number | null }>,
  orders: Array<{
    totalAmount: number;
    financeAmountOverride: number | null;
    financeTreatment: string;
    hasProjectLinks: boolean;
  }>,
): Promise<{
  projectRevenue: number;
  standaloneOrderRevenue: number;
  total: number;
}> {
  const projectRevenue = await computeBatchProjectRevenue(projects);

  let standaloneOrderRevenue = 0;
  for (const o of orders) {
    const treatment = getOrderEffectiveTreatment(o.financeTreatment, o.hasProjectLinks);
    if (treatment === "STANDALONE") {
      standaloneOrderRevenue += computeOrderRevenueAmount(o);
    }
  }

  return {
    projectRevenue,
    standaloneOrderRevenue,
    total: projectRevenue + standaloneOrderRevenue,
  };
}

/**
 * Batch version: compute project revenue for many projects at once.
 * Projects with budgetAmount > 0 use that value directly.
 * Projects without budgetAmount have their linked order amounts fetched
 * in a single query and aggregated by projectId.
 */
export async function computeBatchProjectRevenue(
  projects: Array<{ id: string; budgetAmount: number | null }>,
): Promise<number> {
  if (projects.length === 0) return 0;

  let total = 0;
  const fallbackIds: string[] = [];

  for (const p of projects) {
    if (p.budgetAmount != null && p.budgetAmount > 0) {
      total += p.budgetAmount;
    } else {
      fallbackIds.push(p.id);
    }
  }

  if (fallbackIds.length === 0) return total;

  // Single query for all projects that need order-linked revenue
  const links = await prisma.orderProjectLink.findMany({
    where: { projectId: { in: fallbackIds } },
    select: {
      projectId: true,
      allocatedAmount: true,
      order: { select: { totalAmount: true, financeAmountOverride: true, financeTreatment: true, deleted: true } },
    },
  });

  // Aggregate by projectId
  const byProject = new Map<string, number>();
  for (const link of links) {
    if (link.order.deleted) continue;
    const treatment = getOrderEffectiveTreatment(link.order.financeTreatment, true);
    if (treatment !== "PROJECT_INCLUDED") continue;

    const amt = link.allocatedAmount ?? computeOrderFinanceAmount(link.order);
    byProject.set(link.projectId, (byProject.get(link.projectId) || 0) + amt);
  }

  for (const pid of fallbackIds) {
    total += byProject.get(pid) || 0;
  }

  return total;
}

// ─── Cost helpers ─────────────────────────────────────────────────

/**
 * Sum FinanceCost records by scope. All costs are unified through FinanceCost.
 * No direct reads of Project.budgetCost in financial statistics.
 */
export async function sumFinanceCosts(
  scope: { projectId?: string; orderId?: string; profileId?: string },
): Promise<number> {
  const where: Record<string, unknown> = {};
  if (scope.projectId) where.projectId = scope.projectId;
  if (scope.orderId) where.orderId = scope.orderId;
  if (scope.profileId) where.profileId = scope.profileId;

  if (Object.keys(where).length === 0) return 0;

  const agg = await prisma.financeCost.aggregate({
    _sum: { amount: true },
    where,
  });
  return agg._sum.amount || 0;
}

// ─── Budget cost sync ────────────────────────────────────────────

/**
 * Sync a project's budgetCost field into a FinanceCost record.
 * Idempotent via sourceKey = "project-budget-cost:<projectId>".
 * If budgetCost is 0 or null, removes the sync record.
 * Pass an optional tx (Prisma transaction client) to run within an existing transaction.
 */
export async function syncProjectBudgetCost(
  projectId: string,
  budgetCost: number | null | undefined,
  createdById: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx?: any,
): Promise<void> {
  const db = tx ?? prisma;
  const sourceKey = `project-budget-cost:${projectId}`;

  if (!budgetCost || budgetCost <= 0) {
    await db.financeCost.deleteMany({ where: { sourceKey } });
    return;
  }

  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { profileId: true },
  });
  if (!project) return;

  const profileId = project.profileId as string | null;
  if (!profileId) {
    throw new Error(
      `syncProjectBudgetCost: project ${projectId} has no profileId（不再从旧 Customer 锚点反查，请先补齐 Project.profileId）`,
    );
  }

  await db.financeCost.upsert({
    where: { sourceKey },
    update: {
      amount: budgetCost,
      profileId,
      createdById,
    },
    create: {
      projectId,
      profileId,
      amount: budgetCost,
      costType: "OTHER",
      sourceType: "PROJECT_BUDGET_COST",
      sourceKey,
      occurredAt: new Date(),
      remark: "项目成本同步",
      createdById,
    },
  });
}
