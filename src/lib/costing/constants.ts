/**
 * 成本核算模块常量。
 *
 * 对应设计文档 docs/supply-costing-architecture-design-2026-07-10.md 的成本口径、成本状态、
 * 成本来源与 effective 版本优先级。金额单位一律为分（元×100）。
 *
 * 注意：COST_ENTRY_TYPE 必须是现有 FinanceCost.costType（src/lib/finance/costs.ts 的
 * VALID_COST_TYPES）的超集，确保 Phase 4 迁移不破。
 */

// ─── 成本桶（bucket）─────────────────────────────────────────────
export const COST_BUCKET = {
  REAL: "REAL",
  CIRCULATION: "CIRCULATION",
  TAX: "TAX",
} as const;
export type CostBucket = (typeof COST_BUCKET)[keyof typeof COST_BUCKET];

export const VALID_COST_BUCKETS: readonly CostBucket[] = [
  COST_BUCKET.REAL,
  COST_BUCKET.CIRCULATION,
  COST_BUCKET.TAX,
];

// ─── 成本口径（basis）────────────────────────────────────────────
export const COST_BASIS = {
  REAL_ONLY: "REAL_ONLY",
  REAL_PLUS_CIRCULATION: "REAL_PLUS_CIRCULATION",
  FULL: "FULL",
} as const;
export type CostBasis = (typeof COST_BASIS)[keyof typeof COST_BASIS];

export const VALID_COST_BASIS: readonly CostBasis[] = [
  COST_BASIS.REAL_ONLY,
  COST_BASIS.REAL_PLUS_CIRCULATION,
  COST_BASIS.FULL,
];

/**
 * 口径 → 包含的桶集合。REAL_PLUS_CIRCULATION = REAL + CIRCULATION，FULL = 全部。
 */
export function bucketsForBasis(basis: CostBasis): CostBucket[] {
  if (basis === COST_BASIS.REAL_ONLY) return [COST_BUCKET.REAL];
  if (basis === COST_BASIS.REAL_PLUS_CIRCULATION)
    return [COST_BUCKET.REAL, COST_BUCKET.CIRCULATION];
  return [COST_BUCKET.REAL, COST_BUCKET.CIRCULATION, COST_BUCKET.TAX];
}

// ─── 成本类型（costType）─────────────────────────────────────────
// 兼容现有 FinanceCost 9 类 + 设计文档新增。
export const COST_ENTRY_TYPE = {
  // 现有 FinanceCost 类型（保持兼容）
  PROCUREMENT: "PROCUREMENT",
  EXPERIMENT: "EXPERIMENT",
  LABOR: "LABOR",
  LOGISTICS: "LOGISTICS",
  PLATFORM: "PLATFORM",
  MARKETING: "MARKETING",
  ENTERTAINMENT: "ENTERTAINMENT",
  REFUND: "REFUND",
  OTHER: "OTHER",
  // 供应链与设计文档新增
  SUPPLIER: "SUPPLIER",
  PLATFORM_FEE: "PLATFORM_FEE",
  COMMISSION: "COMMISSION",
  TAX: "TAX",
  PROJECT_COST: "PROJECT_COST",
} as const;
export type CostEntryType = (typeof COST_ENTRY_TYPE)[keyof typeof COST_ENTRY_TYPE];

export const VALID_COST_ENTRY_TYPES: readonly CostEntryType[] = Object.values(COST_ENTRY_TYPE);

// ─── 成本状态（status）───────────────────────────────────────────
export const COST_STATUS = {
  ESTIMATED: "ESTIMATED",
  QUOTED: "QUOTED",
  COMMITTED: "COMMITTED",
  ACTUAL: "ACTUAL",
  SETTLED: "SETTLED",
  CANCELLED: "CANCELLED",
} as const;
export type CostStatus = (typeof COST_STATUS)[keyof typeof COST_STATUS];

export const VALID_COST_STATUSES: readonly CostStatus[] = [
  COST_STATUS.ESTIMATED,
  COST_STATUS.QUOTED,
  COST_STATUS.COMMITTED,
  COST_STATUS.ACTUAL,
  COST_STATUS.SETTLED,
  COST_STATUS.CANCELLED,
];

/**
 * 成本状态优先级——同组多条未取消成本，按确定性从高到低取最高。
 * 数字越大优先级越高。SETTLED > ACTUAL > COMMITTED > QUOTED > ESTIMATED。
 * CANCELLED 永不参与（聚合时先排除）。
 */
export const COST_STATUS_PRIORITY: Record<CostStatus, number> = {
  [COST_STATUS.SETTLED]: 5,
  [COST_STATUS.ACTUAL]: 4,
  [COST_STATUS.COMMITTED]: 3,
  [COST_STATUS.QUOTED]: 2,
  [COST_STATUS.ESTIMATED]: 1,
  [COST_STATUS.CANCELLED]: -1,
};

// ─── 成本来源类型（sourceType）───────────────────────────────────
export const COST_SOURCE_TYPE = {
  MANUAL: "MANUAL",
  SUPPLY_PLAN: "SUPPLY_PLAN",
  TAX_RULE: "TAX_RULE",
  CIRCULATION_RULE: "CIRCULATION_RULE",
  IMPORT: "IMPORT",
  LEGACY_FINANCE_COST: "LEGACY_FINANCE_COST",
  PROJECT_BUDGET_COST: "PROJECT_BUDGET_COST",
  ORDER_INITIAL_COST: "ORDER_INITIAL_COST",
  CONTRACT_IMPORT: "CONTRACT_IMPORT",
  COMMISSION: "COMMISSION",
} as const;
export type CostSourceType = (typeof COST_SOURCE_TYPE)[keyof typeof COST_SOURCE_TYPE];

// ─── 成本主体类型（subjectType）──────────────────────────────────
export const COST_SUBJECT_TYPE = {
  ORDER: "ORDER",
  PROJECT: "PROJECT",
  CUSTOMER: "CUSTOMER",
  MANUAL: "MANUAL",
} as const;
export type CostSubjectType = (typeof COST_SUBJECT_TYPE)[keyof typeof COST_SUBJECT_TYPE];

// ─── 价税模式（taxMode）──────────────────────────────────────────
export const TAX_MODE = {
  TAX_EXCLUSIVE: "TAX_EXCLUSIVE",
  TAX_INCLUSIVE: "TAX_INCLUSIVE",
  TAX_ONLY: "TAX_ONLY",
} as const;
export type TaxMode = (typeof TAX_MODE)[keyof typeof TAX_MODE];

// ─── effectiveGroupKey 前缀命名约定 ─────────────────────────────
// 见设计文档 §effectiveGroupKey 命名。
export const EFFECTIVE_GROUP_KEY_PREFIX = {
  SUPPLY_PLAN_LINE: "supply-plan-line:",
  LEGACY_FINANCE_COST: "legacy-finance-cost:",
  PROJECT_BUDGET_COST: "project-budget-cost:",
  ORDER_INITIAL_COST: "order-initial-cost:",
  CONTRACT_LEDGER_COST: "contract-ledger-cost:",
  COMMISSION: "commission:",
  ORDER_COMMISSION: "order-commission:",
  TAX_RULE: "tax-rule:",
  CIRCULATION_RULE: "circulation-rule:",
  MANUAL: "manual:",
} as const;

// ─── 校验函数 ────────────────────────────────────────────────────
export function isValidCostBucket(v: string): v is CostBucket {
  return VALID_COST_BUCKETS.includes(v as CostBucket);
}

export function isValidCostBasis(v: string): v is CostBasis {
  return VALID_COST_BASIS.includes(v as CostBasis);
}

export function isValidCostEntryType(v: string): v is CostEntryType {
  return VALID_COST_ENTRY_TYPES.includes(v as CostEntryType);
}

export function isValidCostStatus(v: string): v is CostStatus {
  return VALID_COST_STATUSES.includes(v as CostStatus);
}

export function isValidTaxMode(v: string): v is TaxMode {
  return Object.values(TAX_MODE).includes(v as TaxMode);
}

/**
 * FinanceCost.costType → CostEntry 的 bucket + costType 映射。
 * 见设计文档 §costType 映射。LABOR/LOGISTICS/OTHER 需人工复核但默认归 REAL。
 */
export const LEGACY_COST_TYPE_MAP: Record<
  string,
  { bucket: CostBucket; costType: CostEntryType }
> = {
  PROCUREMENT: { bucket: COST_BUCKET.REAL, costType: COST_ENTRY_TYPE.PROCUREMENT },
  EXPERIMENT: { bucket: COST_BUCKET.REAL, costType: COST_ENTRY_TYPE.EXPERIMENT },
  LABOR: { bucket: COST_BUCKET.REAL, costType: COST_ENTRY_TYPE.LABOR },
  LOGISTICS: { bucket: COST_BUCKET.REAL, costType: COST_ENTRY_TYPE.LOGISTICS },
  PLATFORM: { bucket: COST_BUCKET.CIRCULATION, costType: COST_ENTRY_TYPE.PLATFORM },
  MARKETING: { bucket: COST_BUCKET.CIRCULATION, costType: COST_ENTRY_TYPE.MARKETING },
  ENTERTAINMENT: { bucket: COST_BUCKET.CIRCULATION, costType: COST_ENTRY_TYPE.ENTERTAINMENT },
  REFUND: { bucket: COST_BUCKET.CIRCULATION, costType: COST_ENTRY_TYPE.REFUND },
  PROJECT_COST: { bucket: COST_BUCKET.REAL, costType: COST_ENTRY_TYPE.PROJECT_COST },
  OTHER: { bucket: COST_BUCKET.REAL, costType: COST_ENTRY_TYPE.OTHER },
};
