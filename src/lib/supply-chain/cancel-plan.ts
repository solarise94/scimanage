/**
 * 供应方案取消 / 替代——cancelSupplyPlan() / supersedeSupplyPlan()。
 *
 * 设计文档 §状态流转触发器 与 §SupplyPlan 约束：
 * - 旧方案状态改为 CANCELLED 或 SUPERSEDED。
 * - 旧方案生成的 CostEntry 同步改为 CANCELLED。
 * - 保留审计，不物理删除。
 * - 重算受影响的 CostSnapshot。
 * - 财务守卫：方案已生成有效 FinancePayable（非 CANCELLED）时阻止取消，
 *   避免出现「成本已取消，但应付仍有效」的财务不一致。已付款的更不能取消。
 * - 非锁定方案：将该方案独占的 PLANNED 需求恢复为 OPEN，避免永久卡在 PLANNED。
 */
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import {
  SUPPLY_PLAN_STATUS,
} from "./constants";
import {
  COST_STATUS,
  COST_SUBJECT_TYPE,
  COST_SOURCE_TYPE,
} from "@/lib/costing/constants";
import { PAYABLE_STATUS } from "@/lib/finance/supplier-finance-constants";
import { recomputeCostSnapshot } from "@/lib/costing/recompute";
import { SUPPLY_REQUIREMENT_STATUS } from "@/lib/products/application/supply-requirements";

type TransactionClient = Prisma.TransactionClient;

/**
 * 将方案独占的 PLANNED 需求恢复为 OPEN。
 * 若其他非终态方案仍引用同一需求，则不释放（避免误开仍被占用的需求）。
 * LOCKED 方案取消时不调用本函数——LOCKED 需求不得回退 OPEN。
 */
async function releasePlannedRequirementsForPlan(
  tx: TransactionClient,
  planId: string,
): Promise<void> {
  const lines = await tx.supplyPlanLine.findMany({
    where: { planId, supplyRequirementId: { not: null } },
    select: { supplyRequirementId: true },
  });
  const requirementIds = [
    ...new Set(
      lines
        .map((l) => l.supplyRequirementId)
        .filter((id): id is string => !!id),
    ),
  ];
  if (requirementIds.length === 0) return;

  for (const requirementId of requirementIds) {
    const stillReferenced = await tx.supplyPlanLine.findFirst({
      where: {
        supplyRequirementId: requirementId,
        planId: { not: planId },
        plan: {
          status: {
            notIn: [
              SUPPLY_PLAN_STATUS.CANCELLED,
              SUPPLY_PLAN_STATUS.SUPERSEDED,
            ],
          },
        },
      },
      select: { id: true },
    });
    if (stillReferenced) continue;

    await tx.supplyRequirement.updateMany({
      where: {
        id: requirementId,
        status: SUPPLY_REQUIREMENT_STATUS.PLANNED,
      },
      data: { status: SUPPLY_REQUIREMENT_STATUS.OPEN },
    });
  }
}

/**
 * 取消供应方案。
 * - 方案 status → CANCELLED
 * - 关联 CostEntry(SUPPLY_PLAN) → CANCELLED
 * - 非 LOCKED 方案：独占 PLANNED 需求 → OPEN
 * - 重算快照
 * - 财务守卫：已生成有效应付时抛 HAS_ACTIVE_PAYABLES（调用方返回 409）
 */
export async function cancelSupplyPlan(params: {
  planId: string;
  actorUserId: string;
  reason?: string;
}): Promise<{ planId: string; cancelledCostEntryIds: string[] }> {
  const { planId, reason } = params;

  return prisma.$transaction(async (tx) => {
    const plan = await tx.supplyPlan.findUnique({
      where: { id: planId },
      select: { id: true, orderId: true, status: true, order: { select: { profileId: true } } },
    });

    if (!plan) throw new Error("NOT_FOUND");
    if (plan.status === SUPPLY_PLAN_STATUS.CANCELLED) {
      return { planId, cancelledCostEntryIds: [] };
    }

    // 财务守卫：已生成有效应付（非 CANCELLED）时禁止取消。
    // 取消方案只取消成本，不会自动取消应付——直接放行会导致
    // 「成本已取消，但应付仍有效」的财务不一致。
    const activePayablesCount = await tx.financePayable.count({
      where: {
        supplyPlanId: planId,
        status: { not: PAYABLE_STATUS.CANCELLED },
      },
    });
    if (activePayablesCount > 0) {
      const err = new Error("HAS_ACTIVE_PAYABLES");
      (err as Error & { count?: number }).count = activePayablesCount;
      throw err;
    }

    const wasLocked = plan.status === SUPPLY_PLAN_STATUS.LOCKED;

    // 取消方案
    await tx.supplyPlan.update({
      where: { id: planId },
      data: {
        status: SUPPLY_PLAN_STATUS.CANCELLED,
        note: reason ? `取消原因：${reason}` : undefined,
      },
    });

    // 非锁定方案：释放独占的 PLANNED 需求，允许后续刷新/重建方案
    if (!wasLocked) {
      await releasePlannedRequirementsForPlan(tx, planId);
    }

    // 取消关联 CostEntry
    const costEntries = await tx.costEntry.findMany({
      where: {
        supplyPlanId: planId,
        sourceType: COST_SOURCE_TYPE.SUPPLY_PLAN,
        status: { not: COST_STATUS.CANCELLED },
      },
      select: { id: true },
    });

    if (costEntries.length > 0) {
      await tx.costEntry.updateMany({
        where: { id: { in: costEntries.map((e) => e.id) } },
        data: {
          status: COST_STATUS.CANCELLED,
          remark: reason ? `方案取消：${reason}` : "方案取消",
        },
      });
    }

    // 重算快照
    await recomputeCostSnapshot(
      { subjectType: COST_SUBJECT_TYPE.ORDER, subjectId: plan.orderId },
      tx,
    );
    // CUSTOMER 主体快照口径 = profileId（与 commit-plan 一致；只认 Profile，不读旧 customerId 列）
    if (plan.order.profileId) {
      await recomputeCostSnapshot(
        { subjectType: COST_SUBJECT_TYPE.CUSTOMER, subjectId: plan.order.profileId },
        tx,
      );
    }

    return {
      planId,
      cancelledCostEntryIds: costEntries.map((e) => e.id),
    };
  });
}

/**
 * 替代供应方案（新方案替代旧方案）。
 * - 旧方案 status → SUPERSEDED
 * - 旧方案 CostEntry → CANCELLED
 * - 非 LOCKED 旧方案：独占 PLANNED 需求 → OPEN
 * - 不自动锁定新方案（由调用方后续 lockSupplyPlan）
 */
export async function supersedeSupplyPlan(params: {
  oldPlanId: string;
  newPlanId?: string;
  actorUserId: string;
  reason?: string;
}): Promise<{ oldPlanId: string; cancelledCostEntryIds: string[] }> {
  const { oldPlanId, newPlanId, reason } = params;

  return prisma.$transaction(async (tx) => {
    const plan = await tx.supplyPlan.findUnique({
      where: { id: oldPlanId },
      select: { id: true, orderId: true, status: true, order: { select: { profileId: true } } },
    });

    if (!plan) throw new Error("NOT_FOUND");
    if (plan.status === SUPPLY_PLAN_STATUS.SUPERSEDED) {
      return { oldPlanId, cancelledCostEntryIds: [] };
    }

    const wasLocked = plan.status === SUPPLY_PLAN_STATUS.LOCKED;

    await tx.supplyPlan.update({
      where: { id: oldPlanId },
      data: {
        status: SUPPLY_PLAN_STATUS.SUPERSEDED,
        note: reason
          ? `被替代${newPlanId ? `（新方案 ${newPlanId}）` : ""}：${reason}`
          : `被新方案替代${newPlanId ? ` ${newPlanId}` : ""}`,
      },
    });

    if (!wasLocked) {
      await releasePlannedRequirementsForPlan(tx, oldPlanId);
    }

    // 取消旧方案 CostEntry
    const costEntries = await tx.costEntry.findMany({
      where: {
        supplyPlanId: oldPlanId,
        sourceType: COST_SOURCE_TYPE.SUPPLY_PLAN,
        status: { not: COST_STATUS.CANCELLED },
      },
      select: { id: true },
    });

    if (costEntries.length > 0) {
      await tx.costEntry.updateMany({
        where: { id: { in: costEntries.map((e) => e.id) } },
        data: {
          status: COST_STATUS.CANCELLED,
          remark: `方案被替代${newPlanId ? `（新方案 ${newPlanId}）` : ""}`,
        },
      });
    }

    await recomputeCostSnapshot(
      { subjectType: COST_SUBJECT_TYPE.ORDER, subjectId: plan.orderId },
      tx,
    );
    // CUSTOMER 主体快照口径 = profileId（与 commit-plan 一致；只认 Profile，不读旧 customerId 列）
    if (plan.order.profileId) {
      await recomputeCostSnapshot(
        { subjectType: COST_SUBJECT_TYPE.CUSTOMER, subjectId: plan.order.profileId },
        tx,
      );
    }

    return {
      oldPlanId,
      cancelledCostEntryIds: costEntries.map((e) => e.id),
    };
  });
}
