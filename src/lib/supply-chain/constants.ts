/**
 * 供应链管理模块常量。
 * 对应设计文档 docs/supply-costing-architecture-design-2026-07-10.md。
 */

// ─── 供应商状态 ──────────────────────────────────────────────────
export const SUPPLIER_STATUS = {
  ACTIVE: "ACTIVE",
  PAUSED: "PAUSED",
  BLACKLISTED: "BLACKLISTED",
} as const;
export type SupplierStatus = (typeof SUPPLIER_STATUS)[keyof typeof SUPPLIER_STATUS];
export const VALID_SUPPLIER_STATUSES: readonly SupplierStatus[] = Object.values(SUPPLIER_STATUS);

// ─── 供应商类别 ──────────────────────────────────────────────────
export const SUPPLIER_CATEGORY = {
  SEQUENCING: "SEQUENCING",
  LIBRARY_PREP: "LIBRARY_PREP",
  SPATIAL: "SPATIAL",
  LOGISTICS: "LOGISTICS",
  OTHER: "OTHER",
} as const;
export type SupplierCategory = (typeof SUPPLIER_CATEGORY)[keyof typeof SUPPLIER_CATEGORY];
export const VALID_SUPPLIER_CATEGORIES: readonly SupplierCategory[] = Object.values(SUPPLIER_CATEGORY);

// ─── 付款周期 ────────────────────────────────────────────────────
export const PAYMENT_CYCLE = {
  PREPAID: "PREPAID",
  NET_15: "NET_15",
  NET_30: "NET_30",
  NET_60: "NET_60",
  MONTHLY: "MONTHLY",
  CUSTOM: "CUSTOM",
} as const;
export type PaymentCycle = (typeof PAYMENT_CYCLE)[keyof typeof PAYMENT_CYCLE];

// ─── 服务项类别 ──────────────────────────────────────────────────
export const SERVICE_CATEGORY = {
  SERVICE: "SERVICE",
  PRODUCT: "PRODUCT",
  MIXED: "MIXED",
  OTHER: "OTHER",
} as const;
export type ServiceCategory = (typeof SERVICE_CATEGORY)[keyof typeof SERVICE_CATEGORY];
export const VALID_SERVICE_CATEGORIES: readonly ServiceCategory[] = Object.values(SERVICE_CATEGORY);

// ─── 服务项业务域 ────────────────────────────────────────────────
export const SERVICE_DOMAIN = [
  "SEQUENCING",
  "LIBRARY_PREP",
  "SPATIAL",
  "BIOINFORMATICS",
  "LOGISTICS",
  "OTHER",
] as const;
export type ServiceDomain = (typeof SERVICE_DOMAIN)[number];
export const SERVICE_DOMAIN_LABELS: Record<string, string> = {
  SEQUENCING: "测序",
  LIBRARY_PREP: "建库",
  SPATIAL: "空间组学",
  BIOINFORMATICS: "生信分析",
  LOGISTICS: "物流",
  OTHER: "其他",
};
export function isValidServiceDomain(v: string): boolean {
  return (SERVICE_DOMAIN as readonly string[]).includes(v);
}

// ─── 订单行映射来源 ──────────────────────────────────────────────
export const MAPPING_SOURCE = {
  MANUAL: "MANUAL",
  RULE: "RULE",
  IMPORT: "IMPORT",
  AI: "AI",
  HISTORY: "HISTORY",
} as const;
export type MappingSource = (typeof MAPPING_SOURCE)[keyof typeof MAPPING_SOURCE];

// ─── 报价状态 ────────────────────────────────────────────────────
export const QUOTE_STATUS = {
  ACTIVE: "ACTIVE",
  EXPIRED: "EXPIRED",
  ARCHIVED: "ARCHIVED",
} as const;
export type QuoteStatus = (typeof QUOTE_STATUS)[keyof typeof QUOTE_STATUS];
export const VALID_QUOTE_STATUSES: readonly QuoteStatus[] = Object.values(QUOTE_STATUS);

// ─── 报价来源 ────────────────────────────────────────────────────
export const QUOTE_SOURCE = {
  MANUAL: "MANUAL",
  IMPORT: "IMPORT",
  NEGOTIATION: "NEGOTIATION",
  ORDER_HISTORY: "ORDER_HISTORY",
} as const;
export type QuoteSource = (typeof QUOTE_SOURCE)[keyof typeof QUOTE_SOURCE];

// ─── 询价状态 ────────────────────────────────────────────────────
export const INQUIRY_STATUS = {
  OPEN: "OPEN",
  RESPONDED: "RESPONDED",
  CLOSED: "CLOSED",
  LOST: "LOST",
} as const;
export type InquiryStatus = (typeof INQUIRY_STATUS)[keyof typeof INQUIRY_STATUS];
export const VALID_INQUIRY_STATUSES: readonly InquiryStatus[] = Object.values(INQUIRY_STATUS);

// ─── 供应方案状态 ────────────────────────────────────────────────
export const SUPPLY_PLAN_STATUS = {
  DRAFT: "DRAFT",
  QUOTED: "QUOTED",
  NEGOTIATING: "NEGOTIATING",
  SELECTED: "SELECTED",
  LOCKED: "LOCKED",
  SUPERSEDED: "SUPERSEDED",
  CANCELLED: "CANCELLED",
} as const;
export type SupplyPlanStatus = (typeof SUPPLY_PLAN_STATUS)[keyof typeof SUPPLY_PLAN_STATUS];
export const VALID_SUPPLY_PLAN_STATUSES: readonly SupplyPlanStatus[] = Object.values(SUPPLY_PLAN_STATUS);

/** 当前「有效」的方案状态——同订单同一时间只允许一个 */
export const ACTIVE_PLAN_STATUSES: readonly SupplyPlanStatus[] = [
  SUPPLY_PLAN_STATUS.SELECTED,
  SUPPLY_PLAN_STATUS.LOCKED,
];

// ─── 方案类型 ────────────────────────────────────────────────────
export const PLAN_TYPE = {
  LOWEST_COST: "LOWEST_COST",
  FASTEST: "FASTEST",
  BALANCED: "BALANCED",
  MANUAL: "MANUAL",
} as const;
export type PlanType = (typeof PLAN_TYPE)[keyof typeof PLAN_TYPE];
export const VALID_PLAN_TYPES: readonly PlanType[] = Object.values(PLAN_TYPE);

// ─── 低置信度阈值（低于此值不自动锁定，需人工确认服务项）─────────
export const MAPPING_CONFIDENCE_THRESHOLD = 0.7;

// ─── 校验函数 ────────────────────────────────────────────────────
export function isValidSupplierStatus(v: string): v is SupplierStatus {
  return VALID_SUPPLIER_STATUSES.includes(v as SupplierStatus);
}

export function isValidSupplierCategory(v: string): v is SupplierCategory {
  return VALID_SUPPLIER_CATEGORIES.includes(v as SupplierCategory);
}

export function isValidServiceCategory(v: string): v is ServiceCategory {
  return VALID_SERVICE_CATEGORIES.includes(v as ServiceCategory);
}

export function isValidQuoteStatus(v: string): v is QuoteStatus {
  return VALID_QUOTE_STATUSES.includes(v as QuoteStatus);
}

export function isValidInquiryStatus(v: string): v is InquiryStatus {
  return VALID_INQUIRY_STATUSES.includes(v as InquiryStatus);
}

export function isValidSupplyPlanStatus(v: string): v is SupplyPlanStatus {
  return VALID_SUPPLY_PLAN_STATUSES.includes(v as SupplyPlanStatus);
}

export function isValidPlanType(v: string): v is PlanType {
  return VALID_PLAN_TYPES.includes(v as PlanType);
}
