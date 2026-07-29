/**
 * 财务供应商付款登记与分摊。
 *
 * 设计文档 §付款核销规则：
 * - FinancePayment.amount 是实际付款总额。
 * - FinancePaymentAllocation 分摊总额不得超过付款总额。
 * - FinancePayable.paidAmount 是缓存，事实源是分摊表聚合。
 * - FinancePayable.status 由分摊聚合决定。
 *
 * SETTLED 回调（设计文档 §状态流转触发器）：
 * - 付款分摊事务完成后，markCostEntriesSettledForPayable(payableId)
 *   将已全额核销应付关联的成本项推进到 SETTLED。
 * - 只更新成本确定性，不把付款金额写入 CostSnapshot。
 */
import { prisma } from "@/lib/prisma";
import {
  PAYABLE_STATUS,
  calcPayableStatus,
} from "./supplier-finance-constants";
import { COST_STATUS } from "@/lib/costing/constants";
import { recomputeCostSnapshot } from "@/lib/costing/recompute";
import { isDepartment } from "@/lib/department";

export class PaymentError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = "PaymentError";
  }
}

/**
 * 登记一笔供应商付款并分摊到多笔应付。
 *
 * allocations: [{ payableId, amount }]
 * - 分摊总额不得超过 payment.amount。
 * - 每个 payableId 只能出现一次（@@unique）。
 * - 部门不变量（设计 §7.3）：FinancePayment 只能分摊到同一部门的 Payable，
 *   否则抛 DEPARTMENT_MISMATCH（409）。
 *
 * 事务内：
 * 1. 解析 payment 部门（取 actor.department）；创建 FinancePayment
 * 2. 创建 FinancePaymentAllocation（校验分摊总额 + 同部门）
 * 3. 重算每笔关联 FinancePayable 的 paidAmount + status
 * 4. 对已全额核销（PAID）的应付，调用 markCostEntriesSettledForPayable
 */
export async function registerSupplierPayment(params: {
  supplierId: string;
  amount: number; // 分
  paidAt?: Date;
  method?: string;
  voucherNo?: string;
  voucherUrl?: string;
  remark?: string;
  allocations: { payableId: string; amount: number }[];
  actorUserId: string;
}): Promise<{ paymentId: string; updatedPayableIds: string[] }> {
  const { amount, allocations, actorUserId } = params;

  // 校验分摊总额
  const totalAllocated = allocations.reduce((s, a) => s + a.amount, 0);
  if (totalAllocated > amount) {
    throw new PaymentError(
      `分摊总额 ${totalAllocated} 超过付款金额 ${amount}`,
      "OVER_ALLOCATED",
    );
  }

  return prisma.$transaction(async (tx) => {
    // 解析付款部门（设计 §4.2 / §7.2）：取 actor 部门。
    // Fail-closed（设计 §6.1）：用户不存在或 department 非法时拒绝登记付款，
    // 不能静默落 FIELD_SALES 快照（会产生错误部门付款记录）。
    const actor = await tx.user.findUnique({
      where: { id: actorUserId },
      select: { department: true },
    });
    if (!actor || !isDepartment(actor.department)) {
      throw new PaymentError(
        `无法权威解析操作者 ${actorUserId} 的部门，拒绝登记付款（部门字段缺失或非法）`,
        "DEPARTMENT_UNRESOLVED",
      );
    }
    const paymentDepartment = actor.department;

    // 1. 创建付款记录（带 departmentSnapshot）
    const payment = await tx.financePayment.create({
      data: {
        supplierId: params.supplierId,
        amount,
        paidAt: params.paidAt ?? new Date(),
        method: params.method,
        voucherNo: params.voucherNo,
        voucherUrl: params.voucherUrl,
        remark: params.remark,
        departmentSnapshot: paymentDepartment,
        createdById: actorUserId,
      },
    });

    const updatedPayableIds: string[] = [];

    // 2. 创建分摊 + 重算每笔应付
    for (const alloc of allocations) {
      // 校验应付存在且属于同一供应商
      const payable = await tx.financePayable.findUnique({
        where: { id: alloc.payableId },
        select: { id: true, supplierId: true, amount: true, status: true, departmentSnapshot: true },
      });
      if (!payable) {
        throw new PaymentError(`应付 ${alloc.payableId} 不存在`, "NOT_FOUND");
      }
      if (payable.supplierId !== params.supplierId) {
        throw new PaymentError(
          `应付 ${alloc.payableId} 的供应商与付款不一致`,
          "SUPPLIER_MISMATCH",
        );
      }
      // 设计 §7.3：FinancePayment 只能分摊到同一部门的 Payable。
      if (payable.departmentSnapshot !== paymentDepartment) {
        throw new PaymentError(
          `应付 ${alloc.payableId} 部门（${payable.departmentSnapshot}）与付款部门（${paymentDepartment}）不一致，不能跨部门分摊`,
          "DEPARTMENT_MISMATCH",
        );
      }
      if (payable.status === PAYABLE_STATUS.CANCELLED) {
        throw new PaymentError(`应付 ${alloc.payableId} 已取消`, "PAYABLE_CANCELLED");
      }

      await tx.financePaymentAllocation.create({
        data: {
          paymentId: payment.id,
          payableId: alloc.payableId,
          amount: alloc.amount,
          createdById: actorUserId,
        },
      });

      // 3. 重算该应付的 paidAmount + status
      const refreshed = await recalcPayableStatus(alloc.payableId, tx);
      updatedPayableIds.push(alloc.payableId);

      // 4. 全额核销时推进 CostEntry 到 SETTLED
      if (refreshed.status === PAYABLE_STATUS.PAID) {
        await markCostEntriesSettledForPayable(alloc.payableId, actorUserId, tx);
      }
    }

    return { paymentId: payment.id, updatedPayableIds };
  });
}

/**
 * 从分摊表聚合重算单笔 FinancePayable 的 paidAmount 和 status。
 * 这是事实源——不信任 paidAmount 缓存。
 */
export async function recalcPayableStatus(
  payableId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx?: any,
) {
  const db = tx ?? prisma;

  const payable = await db.financePayable.findUnique({
    where: { id: payableId },
    select: { id: true, amount: true, status: true },
  });
  if (!payable) throw new PaymentError(`应付 ${payableId} 不存在`, "NOT_FOUND");

  // CANCELLED 不重算
  if (payable.status === PAYABLE_STATUS.CANCELLED) return payable;

  const agg = await db.financePaymentAllocation.aggregate({
    _sum: { amount: true },
    where: { payableId },
  });
  const paidAmount = agg._sum.amount ?? 0;
  const newStatus = calcPayableStatus(paidAmount, payable.amount);

  const updated = await db.financePayable.update({
    where: { id: payableId },
    data: { paidAmount, status: newStatus },
  });

  return updated;
}

/**
 * 将已全额核销应付关联的 CostEntry 推进到 SETTLED。
 *
 * 设计文档 §状态流转触发器：
 * SETTLED 是成本确定性/结清标记，不代表 CostSnapshot 存储付款金额。
 * 只更新 status，不写金额。
 *
 * ⚠️ 聚合应付（SUPPLIER_ORDER_PLAN 粒度）只结清该供应商的成本，
 * 不能结清同方案下其他供应商的成本。通过 supplierId 过滤实现。
 */
export async function markCostEntriesSettledForPayable(
  payableId: string,
  actorUserId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx?: any,
) {
  const db = tx ?? prisma;

  const payable = await db.financePayable.findUnique({
    where: { id: payableId },
    select: {
      id: true,
      supplierId: true,
      costEntryId: true,
      orderId: true,
      supplyPlanId: true,
      status: true,
    },
  });
  if (!payable) return;

  // 场景1：应付直接关联单个 CostEntry（COST_ENTRY 粒度）——只结清该条。
  // 与场景2互斥：COST_ENTRY 应付也带有 supplyPlanId/orderId，但只应结清其 costEntryId。
  if (payable.costEntryId) {
    await db.costEntry.updateMany({
      where: {
        id: payable.costEntryId,
        status: { not: COST_STATUS.CANCELLED },
      },
      data: {
        status: COST_STATUS.SETTLED,
        settledAt: new Date(),
        remark: `应付 ${payableId} 全额核销，推进 SETTLED`,
      },
    });
  } else if (payable.supplyPlanId && payable.orderId) {
    // 场景2：聚合应付（SUPPLIER_ORDER_PLAN 粒度，无 costEntryId），结清该方案下该订单 + 该供应商的成本。
    // ⚠️ 必须按 supplierId 过滤，否则支付供应商 A 的应付会错误结清供应商 B 的成本。
    await db.costEntry.updateMany({
      where: {
        supplyPlanId: payable.supplyPlanId,
        orderId: payable.orderId,
        supplierId: payable.supplierId, // 关键：只结清该供应商的成本
        status: { in: [COST_STATUS.COMMITTED, COST_STATUS.ACTUAL] },
      },
      data: {
        status: COST_STATUS.SETTLED,
        settledAt: new Date(),
      },
    });
  }

  // 重算受影响的各级成本快照（status → SETTLED 变化影响 effective 汇总优先级）。
  // 收集被 SETTLED 的 CostEntry 的 profileId/projectId，以及订单关联的客户/项目。
  const settledEntries = await db.costEntry.findMany({
    where: {
      status: COST_STATUS.SETTLED,
      OR: [
        ...(payable.costEntryId ? [{ id: payable.costEntryId }] : []),
        ...(payable.supplyPlanId && payable.orderId
          ? [{ supplyPlanId: payable.supplyPlanId, orderId: payable.orderId, supplierId: payable.supplierId }]
          : []),
      ],
    },
    select: { profileId: true, projectId: true },
  });

  const profileIds = new Set<string>();
  const projectIds = new Set<string>();
  for (const e of settledEntries) {
    if (e.profileId) profileIds.add(e.profileId);
    if (e.projectId) projectIds.add(e.projectId);
  }

  // 通过订单补充客户/项目上下文
  if (payable.orderId) {
    await recomputeCostSnapshot(
      { subjectType: "ORDER", subjectId: payable.orderId },
      db,
    );
    const order = await db.order.findUnique({
      where: { id: payable.orderId },
      select: {
        profileId: true,
        projectLinks: { select: { projectId: true } },
      },
    });
    if (order?.profileId) profileIds.add(order.profileId);
    if (order) {
      for (const link of order.projectLinks) projectIds.add(link.projectId);
    }
  }

  for (const pid of profileIds) {
    await recomputeCostSnapshot({ subjectType: "CUSTOMER", subjectId: pid }, db);
  }
  for (const pid of projectIds) {
    await recomputeCostSnapshot({ subjectType: "PROJECT", subjectId: pid }, db);
  }
}
