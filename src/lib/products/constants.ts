/**
 * 产品与服务目录常量。
 *
 * 对应设计文档 docs/product-catalog-order-supply-cost-integration-design-2026-07-27.md。
 * 产品（Product, SPU）与 SKU（可售/可采购规格）两级结构，统一承担
 * "产品"和"服务"角色，不再设计两套模型。
 */

// ─── 产品类型（kind） ─────────────────────────────────────────────
export const PRODUCT_KIND = {
  SERVICE: "SERVICE",
  PHYSICAL: "PHYSICAL",
  DIGITAL: "DIGITAL",
  COMPOSITE: "COMPOSITE",
  OTHER: "OTHER",
} as const;
export type ProductKind = (typeof PRODUCT_KIND)[keyof typeof PRODUCT_KIND];
export const VALID_PRODUCT_KINDS: readonly ProductKind[] = Object.values(PRODUCT_KIND);
export const PRODUCT_KIND_LABELS: Record<string, string> = {
  SERVICE: "服务",
  PHYSICAL: "实物",
  DIGITAL: "数字产品",
  COMPOSITE: "组合套餐",
  OTHER: "其他",
};

// ─── 产品/SKU 状态 ────────────────────────────────────────────────
export const PRODUCT_STATUS = {
  DRAFT: "DRAFT", // 可维护但不能用于正式下单/报价
  ACTIVE: "ACTIVE", // 可用于新增业务
  RETIRED: "RETIRED", // 保留历史引用，不可新增
  MERGED: "MERGED", // 必须指向替代 SKU
} as const;
export type ProductStatus = (typeof PRODUCT_STATUS)[keyof typeof PRODUCT_STATUS];
export const VALID_PRODUCT_STATUSES: readonly ProductStatus[] = Object.values(PRODUCT_STATUS);
export const PRODUCT_STATUS_LABELS: Record<string, string> = {
  DRAFT: "草稿",
  ACTIVE: "有效",
  RETIRED: "已停用",
  MERGED: "已合并",
};

// ─── 业务域（与 ServiceCatalog 对齐） ─────────────────────────────
export const PRODUCT_DOMAIN = [
  "SEQUENCING",
  "LIBRARY_PREP",
  "SPATIAL",
  "BIOINFORMATICS",
  "LOGISTICS",
  "OTHER",
] as const;
export type ProductDomain = (typeof PRODUCT_DOMAIN)[number];
export const PRODUCT_DOMAIN_LABELS: Record<string, string> = {
  SEQUENCING: "测序",
  LIBRARY_PREP: "建库",
  SPATIAL: "空间组学",
  BIOINFORMATICS: "生信分析",
  LOGISTICS: "物流",
  OTHER: "其他",
};

// ─── 履约模式 ─────────────────────────────────────────────────────
export const FULFILLMENT_MODE = {
  EXTERNAL_OR_INTERNAL: "EXTERNAL_OR_INTERNAL",
  INTERNAL_ONLY: "INTERNAL_ONLY",
  EXTERNAL_ONLY: "EXTERNAL_ONLY",
} as const;
export type FulfillmentMode = (typeof FULFILLMENT_MODE)[keyof typeof FULFILLMENT_MODE];
export const VALID_FULFILLMENT_MODES: readonly FulfillmentMode[] = Object.values(FULFILLMENT_MODE);
export const FULFILLMENT_MODE_LABELS: Record<string, string> = {
  EXTERNAL_OR_INTERNAL: "外采或内部",
  INTERNAL_ONLY: "仅内部",
  EXTERNAL_ONLY: "仅外采",
};

// ─── 别名来源 ─────────────────────────────────────────────────────
export const PRODUCT_ALIAS_SOURCE = {
  MANUAL: "MANUAL",
  IMPORT: "IMPORT",
  LEGACY_SERVICE_KEY: "LEGACY_SERVICE_KEY",
  SUPPLIER_SKU_CODE: "SUPPLIER_SKU_CODE",
} as const;
export type ProductAliasSource = (typeof PRODUCT_ALIAS_SOURCE)[keyof typeof PRODUCT_ALIAS_SOURCE];

// ─── BOM 组件角色 ─────────────────────────────────────────────────
export const SKU_COMPONENT_ROLE = {
  PROCUREMENT: "PROCUREMENT", // 进供应商比价
  INTERNAL: "INTERNAL", // 内部实验/人工成本，不强制供应商报价
  LOGISTICS: "LOGISTICS",
  OPTIONAL: "OPTIONAL",
} as const;
export type SkuComponentRole = (typeof SKU_COMPONENT_ROLE)[keyof typeof SKU_COMPONENT_ROLE];
export const VALID_SKU_COMPONENT_ROLES: readonly SkuComponentRole[] = Object.values(SKU_COMPONENT_ROLE);

// ─── 变更日志 action ──────────────────────────────────────────────
export const PRODUCT_CHANGE_ACTION = {
  PRODUCT_CREATED: "PRODUCT_CREATED",
  PRODUCT_UPDATED: "PRODUCT_UPDATED",
  PRODUCT_RETIRED: "PRODUCT_RETIRED",
  SKU_CREATED: "SKU_CREATED",
  SKU_UPDATED: "SKU_UPDATED",
  SKU_RETIRED: "SKU_RETIRED",
  SKU_MERGED: "SKU_MERGED",
  ALIAS_ADDED: "ALIAS_ADDED",
  ALIAS_REMOVED: "ALIAS_REMOVED",
} as const;

// ─── BusinessSequence keys ────────────────────────────────────────
export const SEQUENCE_KEY = {
  PRODUCT: "PRODUCT",
  PRODUCT_SKU: "PRODUCT_SKU",
} as const;

// ─── 编号格式 ─────────────────────────────────────────────────────
export const PRODUCT_CODE_PREFIX = "PRD";
export const SKU_CODE_PREFIX = "SKU";
export const PRODUCT_CODE_PAD = 6; // PRD-000001

// ─── 治理桶 ───────────────────────────────────────────────────────
export const GOVERNANCE_PROJECT_SYSTEM_TYPE = {
  NORMAL: "NORMAL",
  GOVERNANCE_BUCKET: "GOVERNANCE_BUCKET",
} as const;

/** PRJ-OTHER 固定治理桶标识。 */
export const GENERAL_OTHER_PROJECT = {
  PROJECT_NO: "PRJ-OTHER",
  NAME: "其他项目（历史治理）",
  SYSTEM_KEY: "GENERAL_OTHER_PROJECT",
  SYSTEM_TYPE: "GOVERNANCE_BUCKET" as const,
} as const;

/** 治理 assignment reasonCode。 */
export const GOVERNANCE_REASON_CODE = {
  MISSING_PROJECT_NO: "MISSING_PROJECT_NO",
  UNRESOLVED_PROJECT: "UNRESOLVED_PROJECT",
  LEGACY_MISC: "LEGACY_MISC",
} as const;

// ─── 校验函数 ─────────────────────────────────────────────────────
export function isValidProductKind(v: string): v is ProductKind {
  return VALID_PRODUCT_KINDS.includes(v as ProductKind);
}
export function isValidProductStatus(v: string): v is ProductStatus {
  return VALID_PRODUCT_STATUSES.includes(v as ProductStatus);
}
export function isValidProductDomain(v: string): v is ProductDomain {
  return (PRODUCT_DOMAIN as readonly string[]).includes(v);
}
export function isValidFulfillmentMode(v: string): v is FulfillmentMode {
  return VALID_FULFILLMENT_MODES.includes(v as FulfillmentMode);
}
export function isValidSkuComponentRole(v: string): v is SkuComponentRole {
  return VALID_SKU_COMPONENT_ROLES.includes(v as SkuComponentRole);
}

/** 规范化别名（用于去重和唯一约束匹配）。 */
export function normalizeAlias(alias: string): string {
  return alias.trim().toLowerCase().replace(/\s+/g, " ");
}
