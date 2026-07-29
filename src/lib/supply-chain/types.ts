/**
 * 供应链管理模块类型定义。
 */
import type { PlanType, SupplyPlanStatus } from "./constants";
import type { SkuComponentRole } from "@/lib/products/constants";

export type { PlanType, SupplyPlanStatus };

/** buildSupplyPlanCandidates 的约束参数 */
export interface SupplyPlanConstraints {
  /** 最多供应商数量 */
  maxSuppliers?: number;
  /** 限定的供应商 ID */
  supplierIds?: string[];
  /** 排除的供应商 ID */
  excludedSupplierIds?: number[] | string[];
  /** 最大货期（天） */
  maxLeadDays?: number;
  /** 要求必须有有效报价 */
  requireActiveQuote?: boolean;
}

/** buildSupplyPlanCandidates 的参数 */
export interface BuildSupplyPlanCandidatesParams {
  orderId: string;
  mode: PlanType;
  constraints?: SupplyPlanConstraints;
}

/** 候选方案行的供应商报价信息 */
export interface CandidateQuote {
  quoteId: string;
  supplierId: string;
  supplierName: string;
  unitCost: number; // 分
  leadDays: number | null;
  discountRate: number | null;
  minQuantity: number | null;
}

/**
 * 候选方案中的单个供应需求（requirement 粒度）。
 *
 * review #3/#1：一个订单行可能展开为多条需求（组合 SKU 按 BOM 拆分），
 * 每条需求独立匹配报价、独立选最优、独立生成 SupplyPlanLine。
 * DIRECT 需求 = 订单行本身；BOM 需求 = 组件。
 *
 * legacy 兼容：无 productSkuId 时仅有 serviceKey；此时不得走 ProductSku 展开。
 */
export interface CandidateLine {
  /** 来源订单行 */
  orderLineId: string;
  /** 该候选行对应的供应需求 id（若已持久化）；纯预览展开的临时需求为 null */
  supplyRequirementId: string | null;
  /** 展开来源：DIRECT = 订单行 SKU 本身；BOM = 组合 SKU 的组件 */
  source: "DIRECT" | "BOM";
  /**
   * 该需求采购的组件/产品 SKU id。
   * legacy serviceKey-only 行为 null（不得把 serviceKey 填入此字段）。
   */
  productSkuId: string | null;
  /** 根销售 SKU id（BOM 需求的 rootSkuId；DIRECT = productSkuId；legacy = null） */
  rootSkuId: string | null;
  /** 组件路径（BOM 展开路径，DIRECT 为 null） */
  componentPath: string | null;
  /** 订单行原始数量（BOM 展开时传给 expand 的根数量，不可用 quantity 代替） */
  orderQuantity: number;
  /** 该需求的采购数量（BOM = component.quantity × orderQuantity） */
  quantity: number;
  unit: string;
  /** 需求的 definitionHash（创建方案行时冻结；锁定时复核） */
  definitionHash: string;
  /** BOM 组件角色；DIRECT/legacy 为 null */
  role: SkuComponentRole | null;
  /** 该需求对应 SKU 的产品编号快照（BOM 用组件产品；DIRECT 用销售产品） */
  productCodeSnapshot: string | null;
  /** 该需求对应 SKU 编号快照 */
  skuCodeSnapshot: string | null;
  /** 展示用名称 */
  itemName: string;
  spec: string | null;
  /** legacy serviceKey（兼容期回退用；有 productSkuId 时通常为 null） */
  serviceKey: string | null;
  /** 映射置信度（仅 DIRECT 行有；BOM 组件继承订单行） */
  confidence: number | null;
  /** 是否需要人工确认 */
  needsConfirmation: boolean;
  /** 可用供应商报价候选 */
  quotes: CandidateQuote[];
  /** 本需求选中的报价（按 mode 排序后的最优；INTERNAL 可为 null） */
  selectedQuote: CandidateQuote | null;
  /** 需求金额（分）= quantity * selectedQuote.unitCost；INTERNAL 无报价时为 0 */
  lineAmount: number;
}

/** 生成的供应方案候选 */
export interface SupplyPlanCandidate {
  orderId: string;
  mode: PlanType;
  planType: PlanType;
  /** 所有供应需求候选行（requirement 粒度） */
  lines: CandidateLine[];
  /** 方案总报价成本（分）= sum(lineAmount) */
  totalQuotedCost: number;
  /** 预计总货期（最长行） */
  expectedLeadDays: number | null;
  /** 涉及的供应商数量 */
  supplierCount: number;
  /** 是否所有行都已映射并可锁定 */
  readyToLock: boolean;
  /** 阻止锁定的问题列表 */
  blockingIssues: string[];
}
