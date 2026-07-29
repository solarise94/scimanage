/**
 * 成本核算模块类型定义。
 * 金额单位：lib 层统一使用分（cents），API 层再按页面约定转换为元。
 */
import type { CostBasis, CostBucket, CostStatus, CostSubjectType } from "./constants";

export type { CostBasis, CostBucket, CostStatus, CostSubjectType };

/** 成本摘要——getCostSummary() 返回类型 */
export interface CostSummary {
  subjectType: "ORDER" | "PROJECT" | "CUSTOMER";
  subjectId: string;
  basis: CostBasis;
  /** 分 */
  realCost: number;
  /** 分 */
  circulationCost: number;
  /** 分 */
  taxCost: number;
  /** 分 */
  totalCost: number;
  /** 分 */
  estimatedCost: number;
  /** 分 */
  quotedCost: number;
  /** 分 */
  committedCost: number;
  /** 分 */
  actualCost: number;
  /** 分 */
  settledCost: number;
}

/** 利润口径结果（收入来自订单/财务侧，成本来自 CostSummary） */
export interface MarginResult {
  /** 订单收入（financeAmountOverride ?? totalAmount），分 */
  revenue: number;
  /** 供应链毛利 = 收入 - REAL，分 */
  supplyChainGrossMargin: number;
  /** 经营毛利 = 收入 - REAL - CIRCULATION，分 */
  operatingGrossMargin: number;
  /** 净贡献 = 收入 - REAL - CIRCULATION - TAX，分 */
  netContribution: number;
  /** 毛利率（基于 netContribution） */
  netContributionRate: number | null;
}

/** getCostSummary 参数 */
export interface GetCostSummaryParams {
  subjectType: "ORDER" | "PROJECT" | "CUSTOMER";
  subjectId: string;
  basis: CostBasis;
}

/** recomputeCostSnapshot 参数 */
export interface RecomputeCostSnapshotParams {
  subjectType: "ORDER" | "PROJECT" | "CUSTOMER";
  subjectId: string;
}

/** effective 成本聚合中间结构 */
export interface EffectiveCostRollup {
  realCost: number;
  circulationCost: number;
  taxCost: number;
  fullCost: number;
  estimatedCost: number;
  quotedCost: number;
  committedCost: number;
  actualCost: number;
  settledCost: number;
}
