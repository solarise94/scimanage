/**
 * 财务供应商应付生成——createPayablesFromLockedPlan()。
 *
 * 设计文档 §财务应付生成接口 与 §FinancePayable 应付粒度：
 * - 默认 COST_ENTRY 粒度：每个 CostEntry 生成一笔应付，可追溯，避免跨供应商聚合歧义。
 * - SUPPLIER_ORDER_PLAN 粒度：按 supplierId + orderId + supplyPlanId 聚合生成一笔应付。
 * - 财务侧显式从已锁定方案或其 CostEntry 生成 FinancePayable。
 * - 幂等：sourceType=SUPPLY_PLAN, sourceKey=supply-plan:<planId>:<supplierId|costEntryId>
 *
 * 不写 CostSnapshot，不写 FinancePayment。
 */
import { prisma } from "@/lib/prisma";
import {
  PAYABLE_STATUS,
  PAYABLE_SOURCE_TYPE,
  PAYABLE_GRANULARITY,
  type PayableGranularity,
} from "./supplier-finance-constants";
import { COST_SOURCE_TYPE, COST_STATUS } from "@/lib/costing/constants";
import { SUPPLY_PLAN_STATUS } from "@/lib/supply-chain/constants";

/**
 * 从已锁定供应方案生成 FinancePayable。
 *
 * granularity:
 *   COST_ENTRY（默认）：每个 CostEntry 生成一笔应付，可追溯，避免跨供应商聚合歧义
 *   SUPPLIER_ORDER_PLAN：按 supplierId + orderId + supplyPlanId 聚合
 *
 * 幂等：sourceType=SUPPLY_PLAN, sourceKey 唯一。
 */
export async function createPayablesFromLockedPlan(params: {
  planId: string;
  actorUserId: string;
  granularity?: PayableGranularity;
}): Promise<{ createdPayableIds: string[]; skipped: number }> {
  const { planId, actorUserId } = params;
  // 默认 COST_ENTRY 粒度（每个成本项一笔应付，可追溯，避免跨供应商聚合歧义）
  const granularity = params.granularity ?? PAYABLE_GRANULARITY.COST_ENTRY;

  return prisma.$transaction(async (tx) => {
    const plan = await tx.supplyPlan.findUnique({
      where: { id: planId },
      select: {
        id: true,
        orderId: true,
        status: true,
        order: { select: { deleted: true, departmentSnapshot: true } },
      },
    });

    if (!plan) throw new Error("NOT_FOUND");
    if (plan.status !== SUPPLY_PLAN_STATUS.LOCKED) {
      throw new Error(`方案状态为 ${plan.status}，只有 LOCKED 方案才能生成应付`);
    }
    if (plan.order.deleted) throw new Error("订单已删除");

    // 设计 §4.2 / §7.3：Payable 继承关联 Order 的部门（Order 与 Plan/成本项必须同部门）。
    const payableDepartment = plan.order.departmentSnapshot;

    // 读取方案关联的未取消、有效 CostEntry
    const costEntries = await tx.costEntry.findMany({
      where: {
        supplyPlanId: planId,
        sourceType: COST_SOURCE_TYPE.SUPPLY_PLAN,
        status: { not: COST_STATUS.CANCELLED },
        supplierId: { not: null },
      },
      select: {
        id: true,
        supplierId: true,
        amount: true,
        expectedPayAt: true,
        departmentSnapshot: true,
      },
    });

    if (costEntries.length === 0) {
      return { createdPayableIds: [], skipped: 0 };
    }

    // 设计 §7.3：CostEntry 必须与关联 Order 同部门，不一致则 409。
    const mismatched = costEntries.filter((ce) => ce.departmentSnapshot !== payableDepartment);
    if (mismatched.length > 0) {
      throw new Error(
        `方案 ${planId} 下成本项部门与订单部门（${payableDepartment}）不一致，拒绝生成跨部门应付`,
      );
    }

    const createdPayableIds: string[] = [];
    let skipped = 0;

    if (granularity === PAYABLE_GRANULARITY.COST_ENTRY) {
      // 每条 CostEntry 一笔应付
      for (const ce of costEntries) {
        const sourceKey = `supply-plan:${planId}:${ce.id}`;
        try {
          const payable = await tx.financePayable.create({
            data: {
              supplierId: ce.supplierId!,
              orderId: plan.orderId,
              projectId: null,
              costEntryId: ce.id,
              supplyPlanId: planId,
              payableGroupKey: `supplier-order-plan:${ce.supplierId}:${plan.orderId}:${planId}`,
              amount: ce.amount,
              paidAmount: 0,
              status: PAYABLE_STATUS.UNPAID,
              dueAt: ce.expectedPayAt,
              departmentSnapshot: payableDepartment,
              sourceType: PAYABLE_SOURCE_TYPE.SUPPLY_PLAN,
              sourceKey,
              note: `供应方案 ${planId} 成本项`,
              createdById: actorUserId,
            },
          });
          createdPayableIds.push(payable.id);
        } catch (e) {
          if (isUniqueConstraintError(e)) {
            skipped++;
            continue;
          }
          throw e;
        }
      }
    } else {
      // 按 supplierId 聚合
      const bySupplier = new Map<string, { total: number; earliestDue: Date | null }>();
      for (const ce of costEntries) {
        const sid = ce.supplierId!;
        const existing = bySupplier.get(sid);
        if (existing) {
          existing.total += ce.amount;
          if (ce.expectedPayAt && (!existing.earliestDue || ce.expectedPayAt < existing.earliestDue)) {
            existing.earliestDue = ce.expectedPayAt;
          }
        } else {
          bySupplier.set(sid, { total: ce.amount, earliestDue: ce.expectedPayAt ?? null });
        }
      }

      for (const [supplierId, agg] of bySupplier) {
        const sourceKey = `supply-plan:${planId}:${supplierId}`;
        try {
          const payable = await tx.financePayable.create({
            data: {
              supplierId,
              orderId: plan.orderId,
              projectId: null,
              supplyPlanId: planId,
              payableGroupKey: `supplier-order-plan:${supplierId}:${plan.orderId}:${planId}`,
              amount: agg.total,
              paidAmount: 0,
              status: PAYABLE_STATUS.UNPAID,
              dueAt: agg.earliestDue,
              departmentSnapshot: payableDepartment,
              sourceType: PAYABLE_SOURCE_TYPE.SUPPLY_PLAN,
              sourceKey,
              note: `供应方案 ${planId} 汇总应付（${supplierId}）`,
              createdById: actorUserId,
            },
          });
          createdPayableIds.push(payable.id);
        } catch (e) {
          if (isUniqueConstraintError(e)) {
            skipped++;
            continue;
          }
          throw e;
        }
      }
    }

    return { createdPayableIds, skipped };
  });
}

function isUniqueConstraintError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code: string }).code === "P2002"
  );
}

/**
 * 获取供应商付款摘要（来自 FinancePayable 聚合，不读 CostSnapshot）。
 */
export async function getSupplierPaymentSummary(params: {
  subjectType: "ORDER" | "PROJECT" | "SUPPLIER";
  subjectId: string;
}) {
  const { subjectType, subjectId } = params;

  let where: Record<string, unknown>;
  if (subjectType === "ORDER") {
    where = { orderId: subjectId, status: { not: "CANCELLED" } };
  } else if (subjectType === "PROJECT") {
    where = { projectId: subjectId, status: { not: "CANCELLED" } };
  } else {
    where = { supplierId: subjectId, status: { not: "CANCELLED" } };
  }

  const payables = await prisma.financePayable.findMany({
    where,
    select: { amount: true, paidAmount: true, status: true },
  });

  const payableAmount = payables.reduce((s, p) => s + p.amount, 0);
  const paidAmount = payables.reduce((s, p) => s + p.paidAmount, 0);
  const paidCount = payables.filter((p) => p.status === PAYABLE_STATUS.PAID).length;

  return {
    subjectType,
    subjectId,
    payableAmount,
    paidAmount,
    unpaidAmount: payableAmount - paidAmount,
    payableCount: payables.length,
    paidCount,
  };
}
