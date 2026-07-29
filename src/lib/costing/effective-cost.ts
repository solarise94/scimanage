/**
 * Effective 成本选择算法。
 *
 * 设计文档 §成本状态 有效成本规则：
 * 1. CANCELLED 永不参与成本汇总。
 * 2. SETTLED 是 ACTUAL 的付款完成态，成本金额仍归入实际成本；按 SETTLED/ACTUAL 处理避免重复。
 * 3. 同一来源以 effectiveGroupKey 或 sourceType + sourceKey 归组，只取一条当前有效成本。
 * 4. 同组多条未取消成本，按优先级取最高确定性：SETTLED > ACTUAL > COMMITTED > QUOTED > ESTIMATED。
 * 5. CostSnapshot 保存的是当前有效成本按桶聚合后的结果。
 */
import {
  COST_STATUS,
  COST_STATUS_PRIORITY,
  COST_BUCKET,
  type CostBucket,
  type CostStatus,
} from "./constants";
import type { EffectiveCostRollup } from "./types";

/** 零值 rollup */
export function emptyRollup(): EffectiveCostRollup {
  return {
    realCost: 0,
    circulationCost: 0,
    taxCost: 0,
    fullCost: 0,
    estimatedCost: 0,
    quotedCost: 0,
    committedCost: 0,
    actualCost: 0,
    settledCost: 0,
  };
}

/** 一条可聚合的成本行 */
export interface AggregatableCost {
  id: string;
  bucket: string;
  status: string;
  amount: number;
  effectiveGroupKey: string | null;
  sourceType: string;
  sourceKey: string | null;
}

/**
 * 从一组 CostEntry 行中选出有效成本集（去重后）。
 *
 * 分组键：
 * - 有 effectiveGroupKey 时按 effectiveGroupKey 分组。
 * - 否则按 `sourceType + sourceKey` 分组（sourceKey 必须非空，见设计文档幂等规则）。
 * - 若两者都没有（理论上不应发生），按 id 分组（即每条独立）。
 *
 * 每组排除 CANCELLED，取优先级最高的一条。若优先级并列，取 amount 最大者。
 */
export function pickEffectiveCosts(entries: AggregatableCost[]): AggregatableCost[] {
  const groups = new Map<string, AggregatableCost[]>();

  for (const entry of entries) {
    // CANCELLED 永不参与
    if (entry.status === COST_STATUS.CANCELLED) continue;

    const groupKey =
      entry.effectiveGroupKey ||
      (entry.sourceKey ? `${entry.sourceType}:${entry.sourceKey}` : entry.id);

    const arr = groups.get(groupKey);
    if (arr) {
      arr.push(entry);
    } else {
      groups.set(groupKey, [entry]);
    }
  }

  const result: AggregatableCost[] = [];
  for (const arr of groups.values()) {
    // 按 COST_STATUS_PRIORITY 降序，优先级并列时按 amount 降序
    arr.sort((a, b) => {
      const pa = COST_STATUS_PRIORITY[a.status as CostStatus] ?? 0;
      const pb = COST_STATUS_PRIORITY[b.status as CostStatus] ?? 0;
      if (pb !== pa) return pb - pa;
      return b.amount - a.amount;
    });
    result.push(arr[0]);
  }
  return result;
}

/**
 * 将有效成本集合聚合为桶汇总。
 * fullCost = realCost + circulationCost + taxCost。
 */
export function aggregateEffectiveCosts(effective: AggregatableCost[]): EffectiveCostRollup {
  const rollup = emptyRollup();

  for (const entry of effective) {
    const amount = entry.amount;
    const bucket = entry.bucket as CostBucket;
    const status = entry.status as CostStatus;

    // 按桶累加
    if (bucket === COST_BUCKET.REAL) rollup.realCost += amount;
    else if (bucket === COST_BUCKET.CIRCULATION) rollup.circulationCost += amount;
    else if (bucket === COST_BUCKET.TAX) rollup.taxCost += amount;

    // 按状态漏斗累加（审计用，非直接相加成总成本）
    if (status === COST_STATUS.ESTIMATED) rollup.estimatedCost += amount;
    else if (status === COST_STATUS.QUOTED) rollup.quotedCost += amount;
    else if (status === COST_STATUS.COMMITTED) rollup.committedCost += amount;
    else if (status === COST_STATUS.ACTUAL) rollup.actualCost += amount;
    else if (status === COST_STATUS.SETTLED) rollup.settledCost += amount;
  }

  rollup.fullCost = rollup.realCost + rollup.circulationCost + rollup.taxCost;
  return rollup;
}
