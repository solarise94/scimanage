/**
 * 财务供应商付款模块常量。
 * 对应设计文档 docs/supply-costing-architecture-design-2026-07-10.md §财务付款状态。
 */

// ─── 付款状态（FinancePayable.status）────────────────────────────
export const PAYABLE_STATUS = {
  UNPAID: "UNPAID",
  PARTIAL: "PARTIAL",
  PAID: "PAID",
  OVERPAID: "OVERPAID",
  CANCELLED: "CANCELLED",
} as const;
export type PayableStatus = (typeof PAYABLE_STATUS)[keyof typeof PAYABLE_STATUS];
export const VALID_PAYABLE_STATUSES: readonly PayableStatus[] = Object.values(PAYABLE_STATUS);

// ─── 应付来源类型 ────────────────────────────────────────────────
export const PAYABLE_SOURCE_TYPE = {
  MANUAL: "MANUAL",
  COST_ENTRY: "COST_ENTRY",
  SUPPLY_PLAN: "SUPPLY_PLAN",
} as const;
export type PayableSourceType = (typeof PAYABLE_SOURCE_TYPE)[keyof typeof PAYABLE_SOURCE_TYPE];

// ─── 付款方式 ────────────────────────────────────────────────────
export const PAYMENT_METHOD = {
  BANK_TRANSFER: "BANK_TRANSFER",
  ALIPAY: "ALIPAY",
  WECHAT_PAY: "WECHAT_PAY",
  CASH: "CASH",
  CHECK: "CHECK",
  OTHER: "OTHER",
} as const;
export type PaymentMethod = (typeof PAYMENT_METHOD)[keyof typeof PAYMENT_METHOD];

// ─── 应付生成粒度 ────────────────────────────────────────────────
export const PAYABLE_GRANULARITY = {
  /** 按 supplierId + orderId + supplyPlanId 聚合生成一笔应付 */
  SUPPLIER_ORDER_PLAN: "SUPPLIER_ORDER_PLAN",
  /** 每个 CostEntry 生成一笔应付 */
  COST_ENTRY: "COST_ENTRY",
} as const;
export type PayableGranularity = (typeof PAYABLE_GRANULARITY)[keyof typeof PAYABLE_GRANULARITY];

// ─── 校验函数 ────────────────────────────────────────────────────
export function isValidPayableStatus(v: string): v is PayableStatus {
  return VALID_PAYABLE_STATUSES.includes(v as PayableStatus);
}

/**
 * 根据已付金额与应付金额计算付款状态。
 */
export function calcPayableStatus(
  paidAmount: number,
  payableAmount: number,
): PayableStatus {
  if (paidAmount <= 0) return PAYABLE_STATUS.UNPAID;
  if (paidAmount < payableAmount) return PAYABLE_STATUS.PARTIAL;
  if (paidAmount === payableAmount) return PAYABLE_STATUS.PAID;
  return PAYABLE_STATUS.OVERPAID;
}
