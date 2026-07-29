/**
 * Phase 4 迁移：FinanceCost → CostEntry。
 *
 * 设计文档 §与现有 FinanceCost 的关系 迁移路径：
 * 1. 新建 CostEntry 和 CostSnapshot，不破坏现有 FinanceCost。
 * 2. 有稳定 sourceKey 的 legacy 记录保留原 sourceType/sourceKey：
 *    - PROJECT_BUDGET_COST + project-budget-cost:<projectId>
 *    - ORDER_INITIAL_COST + order-initial-cost:<orderId>
 *    - CONTRACT_IMPORT + CONTRACT_LEDGER:<projectNo>:cost
 * 3. 没有 sourceKey 的手动记录使用 sourceType=LEGACY_FINANCE_COST, sourceKey=financeCost.id。
 * 4. bucket=REAL, status=ACTUAL。
 * 5. costType 按映射表转换（LEGACY_COST_TYPE_MAP）。
 * 6. subjectType 按明确归属确定（ORDER/PROJECT/CUSTOMER），不能仅靠「哪个 ID 非空」猜测。
 *
 * 幂等：@@unique([sourceType, sourceKey])，重复运行跳过已迁移记录。
 *
 * 用法：npx tsx scripts/migrate-finance-cost-to-cost-entry.ts
 *
 * 注意：此脚本只在停服迁移窗口内运行。运行后 FinanceCost 写入点保持并行（不立即停服）。
 */
import { prisma } from "@/lib/prisma";
import {
  COST_BUCKET,
  COST_STATUS,
  COST_SOURCE_TYPE,
  COST_SUBJECT_TYPE,
  LEGACY_COST_TYPE_MAP,
  type CostBucket,
  type CostEntryType,
  type CostSubjectType,
} from "@/lib/costing/constants";
import { recomputeCostSnapshot } from "@/lib/costing/recompute";

/**
 * 根据 FinanceCost 的来源类型和 ID 组合确定 subjectType（明确归属）。
 *
 * 规则：
 * - PROJECT_BUDGET_COST → PROJECT（项目预算成本，从项目侧产生）
 * - ORDER_INITIAL_COST / CONTRACT_IMPORT → ORDER（订单级成本）
 * - 有 orderId → ORDER
 * - 仅有 projectId（无 orderId）→ PROJECT
 * - 仅有 profileId（无 orderId/projectId）→ CUSTOMER
 * - 都没有 → ORDER（兜底，虽然不应该发生）
 */
function resolveSubjectType(fc: {
  sourceType: string;
  orderId: string | null;
  projectId: string | null;
  profileId: string | null;
}): CostSubjectType {
  const st = fc.sourceType || "MANUAL";

  if (st === COST_SOURCE_TYPE.PROJECT_BUDGET_COST) return COST_SUBJECT_TYPE.PROJECT;
  if (st === COST_SOURCE_TYPE.ORDER_INITIAL_COST || st === COST_SOURCE_TYPE.CONTRACT_IMPORT) {
    return COST_SUBJECT_TYPE.ORDER;
  }

  if (fc.orderId) return COST_SUBJECT_TYPE.ORDER;
  if (fc.projectId) return COST_SUBJECT_TYPE.PROJECT;
  if (fc.profileId) return COST_SUBJECT_TYPE.CUSTOMER;
  return COST_SUBJECT_TYPE.ORDER; // 兜底
}

/**
 * 解析 legacy FinanceCost 的 sourceType + sourceKey，决定 CostEntry 的映射策略。
 *
 * @param fc FinanceCost 记录（需含 id、sourceType、sourceKey）
 * @returns CostEntry 的 sourceType / sourceKey / effectiveGroupKey
 */
function resolveLegacyMapping(fc: {
  id: string;
  sourceType: string;
  sourceKey: string | null;
  costType: string;
}): {
  sourceType: string;
  sourceKey: string;
  effectiveGroupKey: string;
} {
  const st = fc.sourceType || "MANUAL";

  // 有稳定 sourceKey 的来源——保留原 sourceType/sourceKey
  if (fc.sourceKey && [
    "PROJECT_BUDGET_COST",
    "ORDER_INITIAL_COST",
    "CONTRACT_IMPORT",
  ].includes(st)) {
    let prefix = "legacy-finance-cost:";
    if (st === COST_SOURCE_TYPE.PROJECT_BUDGET_COST) prefix = "project-budget-cost:";
    else if (st === COST_SOURCE_TYPE.ORDER_INITIAL_COST) prefix = "order-initial-cost:";
    else if (st === COST_SOURCE_TYPE.CONTRACT_IMPORT) prefix = "contract-ledger-cost:";
    return {
      sourceType: st,
      sourceKey: fc.sourceKey,
      effectiveGroupKey: fc.sourceKey.startsWith(prefix) ? fc.sourceKey : `${prefix}${fc.sourceKey}`,
    };
  }

  // 没有 sourceKey 或 MANUAL——使用 LEGACY_FINANCE_COST 包装。
  // ⚠️ 必须用 fc.id 作为 sourceKey，否则多条 null-sourceKey 记录会因
  // @@unique([sourceType, sourceKey]) 冲突而只迁移第一条。
  return {
    sourceType: COST_SOURCE_TYPE.LEGACY_FINANCE_COST,
    sourceKey: `finance-cost:${fc.id}`,
    effectiveGroupKey: `legacy-finance-cost:${fc.id}`,
  };
}

/**
 * 迁移所有 FinanceCost 到 CostEntry。
 *
 * @param actorUserId 用于 CostEntry.createdById（迁移操作者）
 * @returns 迁移统计
 */
export async function migrateFinanceCostToCostEntry(actorUserId: string) {
  const financeCosts = await prisma.financeCost.findMany({
    orderBy: { createdAt: "asc" },
  });

  let migrated = 0;
  let skipped = 0;
  let reconciled = 0;
  let errors = 0;
  const affectedSubjects = new Set<string>();

  for (const fc of financeCosts) {
    const mapping = resolveLegacyMapping(fc);

    // costType 映射
    const typeMap = LEGACY_COST_TYPE_MAP[fc.costType] || {
      bucket: COST_BUCKET.REAL as CostBucket,
      costType: "OTHER" as CostEntryType,
    };

    const subjectType = resolveSubjectType(fc);

    // 记录受影响的 subject（用于重算快照）——无论新建还是修正都需重算
    if (subjectType === COST_SUBJECT_TYPE.ORDER && fc.orderId) {
      affectedSubjects.add(`ORDER:${fc.orderId}`);
    } else if (subjectType === COST_SUBJECT_TYPE.PROJECT && fc.projectId) {
      affectedSubjects.add(`PROJECT:${fc.projectId}`);
    } else if (subjectType === COST_SUBJECT_TYPE.CUSTOMER && fc.profileId) {
      affectedSubjects.add(`CUSTOMER:${fc.profileId}`);
    }
    // 上下文 ID（非主体）也触发相关层级重算
    if (fc.orderId) affectedSubjects.add(`ORDER:${fc.orderId}`);
    if (fc.projectId) affectedSubjects.add(`PROJECT:${fc.projectId}`);
    if (fc.profileId) affectedSubjects.add(`CUSTOMER:${fc.profileId}`);

    try {
      await prisma.costEntry.create({
        data: {
          subjectType,
          orderId: fc.orderId,
          projectId: fc.projectId,
          profileId: fc.profileId,
          bucket: typeMap.bucket,
          costType: typeMap.costType,
          status: COST_STATUS.ACTUAL,
          amount: fc.amount,
          currency: "CNY",
          effectiveGroupKey: mapping.effectiveGroupKey,
          sourceType: mapping.sourceType,
          sourceKey: mapping.sourceKey,
          remark: fc.remark || `迁移自 FinanceCost ${fc.id}`,
          createdById: actorUserId,
          occurredAt: fc.occurredAt,
        },
      });
      migrated++;
    } catch (e) {
      if (
        typeof e === "object" &&
        e !== null &&
        "code" in e &&
        (e as { code: string }).code === "P2002"
      ) {
        // 已存在（可能来自旧版迁移）——修正 subjectType / bucket / costType / effectiveGroupKey。
        // 旧版迁移把所有记录写成 subjectType=ORDER，这里按 resolveSubjectType 校正归属。
        try {
          const existing = await prisma.costEntry.findUnique({
            where: {
              sourceType_sourceKey: {
                sourceType: mapping.sourceType,
                sourceKey: mapping.sourceKey,
              },
            },
            select: { id: true, subjectType: true, bucket: true, costType: true, effectiveGroupKey: true },
          });

          if (existing) {
            const needsUpdate =
              existing.subjectType !== subjectType ||
              existing.bucket !== typeMap.bucket ||
              existing.costType !== typeMap.costType ||
              existing.effectiveGroupKey !== mapping.effectiveGroupKey;
            if (needsUpdate) {
              await prisma.costEntry.update({
                where: { id: existing.id },
                data: {
                  subjectType,
                  bucket: typeMap.bucket,
                  costType: typeMap.costType,
                  effectiveGroupKey: mapping.effectiveGroupKey,
                },
              });
              reconciled++;
            } else {
              skipped++;
            }
          } else {
            skipped++;
          }
        } catch (reconcileErr) {
          errors++;
          console.error(`修正 FinanceCost ${fc.id} 的 CostEntry 失败:`, reconcileErr);
        }
      } else {
        errors++;
        console.error(`迁移 FinanceCost ${fc.id} 失败:`, e);
      }
    }
  }

  // 重算受影响的快照
  console.log(`重算 ${affectedSubjects.size} 个受影响快照...`);
  for (const subjectKey of affectedSubjects) {
    const [subjectType, subjectId] = subjectKey.split(":");
    try {
      await recomputeCostSnapshot({
        subjectType: subjectType as "ORDER" | "PROJECT" | "CUSTOMER",
        subjectId,
      });
    } catch (e) {
      console.warn(`重算 ${subjectKey} 失败:`, e);
    }
  }

  return {
    total: financeCosts.length,
    migrated,
    reconciled,
    skipped,
    errors,
    recomputedSnapshots: affectedSubjects.size,
  };
}
