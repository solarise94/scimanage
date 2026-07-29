/**
 * 供应方案成本 effectiveGroupKey 构造与拆分规则。
 *
 * 对应设计文档 §7.1。effectiveGroupKey 表示"同一笔逻辑成本义务的不同确定性版本"，
 * 不是付款分期。
 *
 * 供应方案成本建议使用：
 *   SUPPLY_REQUIREMENT:<supplyRequirementId>:PLAN_LINE:<supplyPlanLineId>
 *
 * 规则（§7.1）：
 *  - 同一方案行的 COMMITTED → ACTUAL → SETTLED 使用同一 effectiveGroupKey；
 *  - 每次状态/金额修订用新 sourceKey，但共享 effectiveGroupKey，聚合取最高确定性版本；
 *  - 一个供应需求拆给两个供应商时，产生两条 SupplyPlanLine 和两个 group，成本相加；
 *  - 供应商分批开票但属同一成本义务时，ACTUAL 版本记录累计实际总额；
 *  - 付款分期只写 FinancePaymentAllocation，不为每次付款创建新成本 group；
 *  - 方案被替代时，旧 group 有效成本全转 CANCELLED，新方案行用新 group。
 */

/**
 * 构造供应方案成本的 effectiveGroupKey。
 */
export function buildSupplyPlanCostGroupKey(
  supplyRequirementId: string,
  supplyPlanLineId: string,
): string {
  return `SUPPLY_REQUIREMENT:${supplyRequirementId}:PLAN_LINE:${supplyPlanLineId}`;
}

/**
 * 构造供应方案成本的 sourceKey（与 effectiveGroupKey 不同：sourceKey 每次修订变化）。
 * sourceType=SUPPLY_PLAN 时与 CostEntry.@@unique([sourceType, sourceKey]) 配合保证幂等。
 */
export function buildSupplyPlanCostSourceKey(
  supplyPlanLineId: string,
  version: string,
): string {
  return `supply-plan:${supplyPlanLineId}:${version}`;
}

/**
 * 构造手工直记成本的 effectiveGroupKey（独立 group，不复用供应方案 group）。
 */
export function buildManualCostGroupKey(costEntryId: string): string {
  return `MANUAL:${costEntryId}`;
}

/**
 * 成本确定性优先级（聚合时每组只取最高确定性有效版本）。
 * 数字越大确定性越高。
 */
export const COST_CERTAINTY_RANK: Record<string, number> = {
  ESTIMATED: 1,
  QUOTED: 2,
  COMMITTED: 3,
  ACTUAL: 4,
  SETTLED: 5,
  CANCELLED: 0, // CANCELLED 不参与聚合
};

/**
 * 从一组同 effectiveGroupKey 的成本条目中选出"最高确定性有效版本"。
 * 用于 SKU/订单成本聚合。
 */
export function pickHighestCertaintyCost<T extends { status: string; amount: number }>(
  entries: T[],
): T | null {
  const valid = entries.filter((e) => e.status !== "CANCELLED");
  if (valid.length === 0) return null;
  return valid.reduce((best, cur) =>
    (COST_CERTAINTY_RANK[cur.status] ?? 0) > (COST_CERTAINTY_RANK[best.status] ?? 0) ? cur : best,
  );
}
