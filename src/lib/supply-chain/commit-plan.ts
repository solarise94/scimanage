/**
 * 供应方案锁定——lockSupplyPlan()。
 *
 * 设计文档 §采纳供应方案接口 与 §状态流转触发器：
 * 1. 校验方案状态（必须是 DRAFT/QUOTED/NEGOTIATING/SELECTED）
 * 2. 事务内校验同订单无其他 SELECTED/LOCKED 有效方案
 * 3. 锁定 SupplyPlan（status → LOCKED）
 * 4. review #3：对每条 supplyRequirementId 调用 lockRequirementInTx（复核 BOM hash + 推进 LOCKED）
 * 5. 为每行生成 CostEntry（含 orderLineId/productSkuId/supplyRequirementId 维度）
 * 6. 重算 CostSnapshot
 * 7. 不生成 FinancePayable
 *
 * 锁定方案前必须：
 *   - 校验金额一致（amount === Math.round(quantity * unitCost)）
 *   - 用方案行冻结的 definitionHash 与 requirement / 当前 BOM 三方比较
 *   - 重新校验报价状态、有效期、minQuantity、供应商与 SKU 可用性
 */
import { prisma } from "@/lib/prisma";
import {
  SUPPLY_PLAN_STATUS,
  ACTIVE_PLAN_STATUSES,
  QUOTE_STATUS,
} from "./constants";
import {
  COST_BUCKET,
  COST_STATUS,
  COST_SUBJECT_TYPE,
  COST_SOURCE_TYPE,
  COST_ENTRY_TYPE,
} from "@/lib/costing/constants";
import { recomputeCostSnapshot } from "@/lib/costing/recompute";
import { lockRequirementInTx } from "@/lib/products/application/supply-requirements";
import { PRODUCT_STATUS, SKU_COMPONENT_ROLE } from "@/lib/products/constants";
import { buildSupplyPlanCostGroupKey, buildSupplyPlanCostSourceKey } from "@/lib/costing/supply-cost-groups";

export class SupplyPlanLockError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = "SupplyPlanLockError";
  }
}

function isQuoteCurrentlyValid(quote: {
  validFrom: Date | null;
  validTo: Date | null;
}, now: Date): boolean {
  if (quote.validFrom && quote.validFrom > now) return false;
  if (quote.validTo && quote.validTo < now) return false;
  return true;
}

/**
 * 锁定供应方案。
 *
 * 返回更新后的 plan 和生成的 CostEntry IDs。
 * 错误：
 *   - NOT_FOUND：方案不存在
 *   - INVALID_STATUS：方案状态不允许锁定
 *   - CONFLICT：同订单已有其他 SELECTED/LOCKED 方案
 *   - AMOUNT_MISMATCH：方案行金额不一致
 *   - EMPTY_PLAN：方案无明细
 *   - QUOTE_INVALID / SKU_INVALID / DEFINITION_HASH_MISMATCH / MISSING_REQUIREMENT
 */
export async function lockSupplyPlan(params: {
  planId: string;
  actorUserId: string;
}): Promise<{ planId: string; status: string; costEntryIds: string[] }> {
  const { planId, actorUserId } = params;

  return prisma.$transaction(async (tx) => {
    // 1. 校验方案存在且状态允许
    const plan = await tx.supplyPlan.findUnique({
      where: { id: planId },
      include: {
        lines: {
          include: {
            supplyRequirement: {
              select: { id: true, definitionHash: true, status: true, productSkuId: true },
            },
          },
        },
        order: { select: { id: true, deleted: true, profileId: true, departmentSnapshot: true } },
      },
    });

    if (!plan) throw new SupplyPlanLockError("方案不存在", "NOT_FOUND");
    if (plan.order.deleted) {
      throw new SupplyPlanLockError("订单已删除，不能锁定方案", "INVALID_ORDER");
    }
    if (!plan.order.profileId) {
      throw new SupplyPlanLockError(
        "订单缺少客户归属（profileId），不能锁定供应方案",
        "MISSING_PROFILE",
      );
    }

    const orderProfileId = plan.order.profileId;
    // 设计 §4.2 / §7.3：CostEntry 继承关联 Order 的部门。
    const orderDepartment = plan.order.departmentSnapshot;

    const lockableStatuses = [
      SUPPLY_PLAN_STATUS.DRAFT,
      SUPPLY_PLAN_STATUS.QUOTED,
      SUPPLY_PLAN_STATUS.NEGOTIATING,
      SUPPLY_PLAN_STATUS.SELECTED,
    ];
    if (!lockableStatuses.includes(plan.status as never)) {
      throw new SupplyPlanLockError(
        `方案当前状态为 ${plan.status}，不允许锁定`,
        "INVALID_STATUS",
      );
    }

    if (plan.lines.length === 0) {
      throw new SupplyPlanLockError("方案无明细，不能锁定", "EMPTY_PLAN");
    }

    // 2. 事务内校验同订单无其他 SELECTED/LOCKED 有效方案
    const conflicting = await tx.supplyPlan.findFirst({
      where: {
        orderId: plan.orderId,
        id: { not: planId },
        status: { in: [...ACTIVE_PLAN_STATUSES] },
      },
      select: { id: true, status: true },
    });
    if (conflicting) {
      throw new SupplyPlanLockError(
        `同订单已有 ${conflicting.status} 状态的方案 ${conflicting.id}，不能锁定`,
        "CONFLICT",
      );
    }

    const now = new Date();

    // 3. 校验每行金额 + 报价/SKU 有效性 + definitionHash 快照
    for (const line of plan.lines) {
      const expected = Math.round((line.quantity ?? 1) * line.unitCost);
      if (line.amount !== expected) {
        throw new SupplyPlanLockError(
          `方案行「${line.itemName}」金额不一致：amount=${line.amount}，期望=${expected}`,
          "AMOUNT_MISMATCH",
        );
      }

      const isInternal = line.componentRole === SKU_COMPONENT_ROLE.INTERNAL;

      // SKU-backed 行缺少 requirement → fail-closed（legacy 无 productSkuId 可跳过）
      if (line.productSkuId && !line.supplyRequirementId) {
        throw new SupplyPlanLockError(
          `方案行「${line.itemName}」缺少供应需求关联，不能锁定`,
          "MISSING_REQUIREMENT",
        );
      }

      // 外采行不变量：非 INTERNAL 必须有 supplierId + quoteId
      if (!isInternal) {
        if (!line.quoteId || !line.supplierId) {
          throw new SupplyPlanLockError(
            `方案行「${line.itemName}」缺少供应商或报价，不能锁定`,
            "QUOTE_INVALID",
          );
        }
      }

      // 复核报价（INTERNAL 无报价可跳过）
      if (line.quoteId) {
        const quote = await tx.supplierQuote.findUnique({
          where: { id: line.quoteId },
          select: {
            id: true,
            status: true,
            validFrom: true,
            validTo: true,
            minQuantity: true,
            quotedPrice: true,
            negotiatedPrice: true,
            supplierId: true,
            productSkuId: true,
            serviceKey: true,
            unit: true,
            supplier: { select: { id: true, archived: true, status: true } },
          },
        });
        if (!quote || quote.status !== QUOTE_STATUS.ACTIVE) {
          throw new SupplyPlanLockError(
            `方案行「${line.itemName}」报价已失效或不存在`,
            "QUOTE_INVALID",
          );
        }
        if (!isQuoteCurrentlyValid(quote, now)) {
          throw new SupplyPlanLockError(
            `方案行「${line.itemName}」报价不在有效期内`,
            "QUOTE_INVALID",
          );
        }
        if (quote.minQuantity != null && (line.quantity ?? 0) < quote.minQuantity) {
          throw new SupplyPlanLockError(
            `方案行「${line.itemName}」数量 ${line.quantity} 低于报价门槛 ${quote.minQuantity}`,
            "QUOTE_INVALID",
          );
        }
        if (quote.supplier.archived || quote.supplier.status !== "ACTIVE") {
          throw new SupplyPlanLockError(
            `方案行「${line.itemName}」供应商不可用`,
            "QUOTE_INVALID",
          );
        }
        const expectedUnitCost = quote.negotiatedPrice ?? quote.quotedPrice;
        if (line.unitCost !== expectedUnitCost) {
          throw new SupplyPlanLockError(
            `方案行「${line.itemName}」单价与当前报价不一致`,
            "QUOTE_INVALID",
          );
        }
        if (!line.supplierId || line.supplierId !== quote.supplierId) {
          throw new SupplyPlanLockError(
            `方案行「${line.itemName}」供应商与报价不匹配`,
            "QUOTE_INVALID",
          );
        }
        // SKU 行：报价必须绑定同一 productSkuId
        if (line.productSkuId && quote.productSkuId !== line.productSkuId) {
          throw new SupplyPlanLockError(
            `方案行「${line.itemName}」报价 SKU 与方案行不一致`,
            "QUOTE_INVALID",
          );
        }
        // legacy 行：核对 serviceKey 快照
        if (!line.productSkuId && line.serviceKeySnapshot) {
          if (quote.serviceKey !== line.serviceKeySnapshot) {
            throw new SupplyPlanLockError(
              `方案行「${line.itemName}」报价 serviceKey 与方案快照不一致`,
              "QUOTE_INVALID",
            );
          }
        }
        // 报价单位与方案行单位一致（有报价单位时）
        if (quote.unit && line.unit && quote.unit !== line.unit) {
          throw new SupplyPlanLockError(
            `方案行「${line.itemName}」报价单位「${quote.unit}」与方案单位「${line.unit}」不一致`,
            "QUOTE_INVALID",
          );
        }
      } else if (!isInternal) {
        throw new SupplyPlanLockError(
          `方案行「${line.itemName}」缺少有效报价，不能锁定`,
          "QUOTE_INVALID",
        );
      }

      // 复核 SKU ACTIVE + purchasable（有 productSkuId 时）
      if (line.productSkuId) {
        const sku = await tx.productSku.findUnique({
          where: { id: line.productSkuId },
          select: { id: true, status: true, purchasable: true },
        });
        if (!sku || sku.status !== PRODUCT_STATUS.ACTIVE) {
          throw new SupplyPlanLockError(
            `方案行「${line.itemName}」SKU 不存在或非 ACTIVE`,
            "SKU_INVALID",
          );
        }
        // INTERNAL 组件可不要求 purchasable；采购类必须可采购
        if (!isInternal && !sku.purchasable) {
          throw new SupplyPlanLockError(
            `方案行「${line.itemName}」SKU 不可采购`,
            "SKU_INVALID",
          );
        }
      }
    }

    // 4. review #3：对每条 supplyRequirementId 调用 lockRequirementInTx
    //    传入方案行冻结的 definitionHash（非 requirement 当前值自比较）
    for (const line of plan.lines) {
      if (!line.supplyRequirementId) continue;
      if (!line.definitionHash) {
        throw new SupplyPlanLockError(
          `方案行「${line.itemName}」缺少 definitionHash 快照，不能锁定`,
          "DEFINITION_HASH_MISMATCH",
        );
      }
      try {
        await lockRequirementInTx(tx, line.supplyRequirementId, line.definitionHash);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new SupplyPlanLockError(msg, "DEFINITION_HASH_MISMATCH");
      }
    }

    // 5. 锁定方案
    await tx.supplyPlan.update({
      where: { id: planId },
      data: {
        status: SUPPLY_PLAN_STATUS.LOCKED,
        lockedAt: new Date(),
        totalLockedCost: plan.lines.reduce((s, l) => s + l.amount, 0),
      },
    });

    // 6. review #3：为每行生成 CostEntry（含 orderLineId/productSkuId/supplyRequirementId 维度）
    //    INTERNAL 且金额为 0：仍落 ESTIMATED/EXPERIMENT 占位，便于后续录入实际内部成本
    const costEntryIds: string[] = [];
    for (const line of plan.lines) {
      const isInternal = line.componentRole === SKU_COMPONENT_ROLE.INTERNAL;
      const sourceKey = buildSupplyPlanCostSourceKey(line.id, "v1");
      const effectiveGroupKey = line.supplyRequirementId
        ? buildSupplyPlanCostGroupKey(line.supplyRequirementId, line.id)
        : buildSupplyPlanCostSourceKey(line.id, "v1");

      const costEntry = await tx.costEntry.create({
        data: {
          subjectType: COST_SUBJECT_TYPE.ORDER,
          orderId: plan.orderId,
          profileId: orderProfileId,
          departmentSnapshot: orderDepartment,
          bucket: COST_BUCKET.REAL,
          costType: isInternal ? COST_ENTRY_TYPE.EXPERIMENT : COST_ENTRY_TYPE.SUPPLIER,
          status: isInternal && line.amount === 0 ? COST_STATUS.ESTIMATED : COST_STATUS.COMMITTED,
          amount: line.amount,
          effectiveGroupKey,
          supplierId: line.supplierId,
          quoteId: line.quoteId,
          supplyPlanId: planId,
          supplyPlanLineId: line.id,
          orderLineId: line.orderLineId,
          productSkuId: line.productSkuId,
          supplyRequirementId: line.supplyRequirementId,
          productCodeSnapshot: line.productCodeSnapshot,
          skuCodeSnapshot: line.skuCodeSnapshot,
          sourceType: COST_SOURCE_TYPE.SUPPLY_PLAN,
          sourceKey,
          remark: isInternal
            ? `供应方案 ${plan.name || planId} 内部组件：${line.itemName}`
            : `供应方案 ${plan.name || planId} 明细：${line.itemName}`,
          createdById: actorUserId,
          occurredAt: new Date(),
        },
      });
      costEntryIds.push(costEntry.id);
    }

    // 7. 重算订单成本快照
    await recomputeCostSnapshot(
      { subjectType: COST_SUBJECT_TYPE.ORDER, subjectId: plan.orderId },
      tx,
    );

    // 若订单关联客户 Profile，重算客户快照（subjectId = profileId）
    await recomputeCostSnapshot(
      { subjectType: COST_SUBJECT_TYPE.CUSTOMER, subjectId: orderProfileId },
      tx,
    );

    return { planId, status: SUPPLY_PLAN_STATUS.LOCKED, costEntryIds };
  });
}
