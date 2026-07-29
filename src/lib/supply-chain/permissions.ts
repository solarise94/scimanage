/**
 * 供应链管理模块权限。
 *
 * Scope 复用现有 getOrderScopeWhere()、getEffectiveCrmVisibleProfileIds()、
 * getFinanceProjectScopeWhere()，不另造权限事实源。
 *
 * 设计文档 §权限设计（简单版）：
 *   ADMIN：全量，含底价、报价、供应商付款、规则配置
 *   USER：访问供应链和成本核算，可按权限配置是否查看底价（第一版 false）
 *   REGIONAL_MANAGER：可看下辖相关订单的供应方案和成本摘要，底价隐藏
 *   REPRESENTATIVE：默认不访问供应链和成本模块
 *
 * 部门隔离（设计 §6.5）：scope 按语义拆分，不在共享模型（Supplier /
 * SupplierQuote / ServiceCatalog）上加部门字段。部门隔离发生在执行记录上：
 *   - getSupplyExecutionScopeWhere：SupplyPlan（从 Order 继承）与
 *     order-bound SupplierInquiry 执行 scope。SupplyPlan 无 departmentSnapshot
 *     字段，靠 Order 维度继承；SupplierInquiry 有 departmentSnapshot，非 ADMIN
 *     读时按自身快照过滤（覆盖 orderId=null 的无订单询价）。
 *   - getCostEntryScopeWhere：按自身 departmentSnapshot（设计 §6.5），不能通过
 *     共享 profileId 放宽部门。
 *   - getSupplierPaymentScopeWhere：见 @/lib/finance/supplier-permissions.ts。
 */
import { prisma } from "@/lib/prisma";
import { getOrderScopeWhere } from "@/lib/orders/permissions";
import {
  getFinanceProjectScopeWhere,
  getFinanceProfileScopeWhere,
} from "@/lib/finance/permissions";
import { isDepartment, resolveActorDepartmentOrNull } from "@/lib/department";

// ─── 角色级 gate（client-safe 纯函数在 role-guards.ts）──────────
const SUPPLY_CHAIN_ACCESS_ROLES = new Set(["ADMIN", "USER"]);

export function canAccessSupplyChain(role: string): boolean {
  return SUPPLY_CHAIN_ACCESS_ROLES.has(role);
}

export function isSupplyChainBlocked(role: string): boolean {
  return !canAccessSupplyChain(role);
}

/**
 * 解析非 ADMIN 用户的部门。Fail-closed（设计 §6.1）：
 * 显式传入时仅接受合法部门值；未传入时从 DB 实时解析。
 * 用户不存在或 department 非法时返回 null，调用点据此返回 no-match scope，
 * 不再静默降级为 FIELD_SALES。
 */
async function resolveSupplyChainDepartment(
  userId: string,
  department?: string,
): Promise<string | null> {
  if (department) {
    return isDepartment(department) ? department : null;
  }
  return resolveActorDepartmentOrNull(userId);
}

// ─── 敏感字段权限（第一版仅 ADMIN）──────────────────────────────
export function canViewFloorPrice(role: string): boolean {
  return role === "ADMIN";
}

export function canManageQuotes(role: string): boolean {
  return role === "ADMIN";
}

export function canLockPlan(role: string): boolean {
  return role === "ADMIN" || role === "USER";
}

export function canViewPaymentSummary(role: string): boolean {
  return role === "ADMIN";
}

// ─── SupplyPlan scope（设计 §6.5：从 Order 继承）──────────────────
/**
 * 供应方案（SupplyPlan）执行 scope——从 Order scope 自动继承。
 * - ADMIN：全量（返回 null）
 * - USER：自己可访问的订单下的方案
 * - 其他角色：拒绝（__NO_MATCH__）
 *
 * SupplyPlan 无 departmentSnapshot 字段（设计 §4.2），靠 Order 维度继承。
 * 返回的 where 直接作用于 SupplyPlan 查询（{ orderId: { in } }）。
 */
export async function getSupplyExecutionScopeWhere(
  userId: string,
  role: string,
  department?: string,
): Promise<Record<string, unknown> | null> {
  if (role === "ADMIN") return null;
  if (!canAccessSupplyChain(role)) {
    return { id: { in: ["__NO_MATCH__"] } };
  }

  // USER：复用订单 scope（订单 scope 已 AND departmentSnapshot，设计 §6.2）
  const orderScope = await getOrderScopeWhere(userId, role, prisma, department);
  if (!orderScope) return null; // 理论上不会，但防御性处理

  // 解析出可见 orderIds（SupplyPlan 必挂订单，无需部门过滤）
  const scopedOrders = await prisma.order.findMany({
    where: { AND: [orderScope, { deleted: false }] },
    select: { id: true },
  });
  const orderIds = scopedOrders.map((o) => o.id);
  if (orderIds.length === 0) return { id: { in: ["__NO_MATCH__"] } };
  return { orderId: { in: orderIds } };
}

// ─── SupplierInquiry scope（设计 §6.5：按自身 departmentSnapshot）──
/**
 * 供应商询价（SupplierInquiry）执行 scope。
 * - ADMIN：全量（返回 null）
 * - USER：可见条件 = 关联订单在 Order scope 内 OR 无订单但同部门。
 *   无订单（orderId=null）的询价按自身 departmentSnapshot 过滤，避免漏过滤。
 * - 其他角色：拒绝（__NO_MATCH__）
 *
 * 返回的 where 直接作用于 SupplierInquiry 查询。
 */
export async function getInquiryScopeWhere(
  userId: string,
  role: string,
  department?: string,
): Promise<Record<string, unknown> | null> {
  if (role === "ADMIN") return null;
  if (!canAccessSupplyChain(role)) {
    return { id: { in: ["__NO_MATCH__"] } };
  }

  const resolvedDepartment = await resolveSupplyChainDepartment(userId, department);
  // Fail-closed（设计 §6.1）：部门无法权威解析时返回 no-match，不静默降级为 FIELD_SALES。
  if (!resolvedDepartment) {
    return { id: { in: ["__NO_MATCH__"] } };
  }

  // 复用 Order scope（已 AND departmentSnapshot）解析可见 orderIds
  const orderScope = await getOrderScopeWhere(userId, role, prisma, resolvedDepartment);
  const orConditions: Record<string, unknown>[] = [];
  if (orderScope) {
    const scopedOrders = await prisma.order.findMany({
      where: { AND: [orderScope, { deleted: false }] },
      select: { id: true },
    });
    const orderIds = scopedOrders.map((o) => o.id);
    if (orderIds.length > 0) {
      orConditions.push({ orderId: { in: orderIds } });
    }
  }
  // 无订单但同部门的询价（含无订单询价），部门隔离发生在执行记录上。
  orConditions.push({ AND: [{ orderId: null }, { departmentSnapshot: resolvedDepartment }] });

  return { OR: orConditions };
}

/**
 * @deprecated 设计 §6.5 已按语义拆分为 getSupplyExecutionScopeWhere（SupplyPlan）
 * 与 getInquiryScopeWhere（SupplierInquiry）。新代码请勿使用，调用点应改用语义化
 * helper。本别名保留一个迭代以便逐步迁移，等价于 getSupplyExecutionScopeWhere。
 */
export async function getSupplyChainScopeWhere(
  userId: string,
  role: string,
  department?: string,
): Promise<Record<string, unknown> | null> {
  return getSupplyExecutionScopeWhere(userId, role, department);
}

// ─── CostEntry scope（设计 §6.5：按自身 departmentSnapshot）────────
/**
 * 成本条目（CostEntry）scope。
 * 设计 §6.5：按自身 departmentSnapshot，不能通过共享 profileId 放宽部门。
 *
 * CostEntry.subjectType 支持 ORDER | PROJECT | CUSTOMER | MANUAL。CUSTOMER/MANUAL
 * 可关联共享 profile，若不 AND 自身快照，跨部门业务记录会经共享 profile 互相泄露。
 * 因此非 ADMIN 读 CostEntry 时，全部 OR 分支必须 AND departmentSnapshot = actor.department。
 *
 * 支持 ADMIN / USER / REGIONAL_MANAGER（REPRESENTATIVE 拒绝）。
 */
export async function getCostEntryScopeWhere(
  userId: string,
  role: string,
  department?: string,
): Promise<Record<string, unknown> | null> {
  if (role === "ADMIN") return null;
  // 成本核算允许 USER + REGIONAL_MANAGER；供应链仅 USER。
  // REPRESENTATIVE 无权限。
  if (role !== "USER" && role !== "REGIONAL_MANAGER") {
    return { id: { in: ["__NO_MATCH__"] } };
  }

  const resolvedDepartment = await resolveSupplyChainDepartment(userId, department);
  // Fail-closed（设计 §6.1）：部门无法权威解析时返回 no-match，不静默降级为 FIELD_SALES。
  if (!resolvedDepartment) {
    return { id: { in: ["__NO_MATCH__"] } };
  }

  const scopeOr: Record<string, unknown>[] = [];

  // 订单 scope（订单 scope 自身已 AND departmentSnapshot）
  const orderScope = await getOrderScopeWhere(userId, role, prisma, resolvedDepartment);
  if (orderScope) {
    const scopedOrders = await prisma.order.findMany({
      where: { AND: [orderScope, { deleted: false }] },
      select: { id: true },
    });
    if (scopedOrders.length > 0) {
      scopeOr.push({ orderId: { in: scopedOrders.map((o) => o.id) } });
    }
  }

  // 项目 scope（项目 scope 自身已 AND departmentSnapshot）
  const projectScope = await getFinanceProjectScopeWhere(userId, role, resolvedDepartment);
  if (projectScope) {
    scopeOr.push({ projectId: projectScope.id });
  }

  // Profile scope（共享 profile，不能放宽部门——外层统一 AND 快照）
  const profileScope = await getFinanceProfileScopeWhere(userId, role, resolvedDepartment);
  if (profileScope) {
    scopeOr.push({ profileId: profileScope.id });
  }

  if (scopeOr.length === 0) {
    return { id: { in: ["__NO_MATCH__"] } };
  }
  // 设计 §6.5：CostEntry 按自身 departmentSnapshot，外层统一 AND。
  return { AND: [{ OR: scopeOr }, { departmentSnapshot: resolvedDepartment }] };
}

/**
 * 校验某订单是否对当前用户可见（用于供应方案生成、锁定前的权限校验）。
 * ADMIN 全量通过；其他角色复用 getOrderScopeWhere。
 */
export async function assertOrderVisibleForSupplyChain(
  userId: string,
  role: string,
  orderId: string,
  department?: string,
): Promise<boolean> {
  if (role === "ADMIN") return true;
  if (!canAccessSupplyChain(role)) return false;
  const orderScope = await getOrderScopeWhere(userId, role, prisma, department);
  if (!orderScope) return true;
  const visible = await prisma.order.findFirst({
    where: { AND: [orderScope, { id: orderId, deleted: false }] },
    select: { id: true },
  });
  return !!visible;
}

/**
 * 校验某供应方案是否对当前用户可见。
 * 通过方案的 orderId 反查订单 scope。
 */
export async function assertSupplyPlanVisible(
  userId: string,
  role: string,
  planId: string,
  department?: string,
): Promise<boolean> {
  if (role === "ADMIN") return true;
  if (!canAccessSupplyChain(role)) return false;
  const plan = await prisma.supplyPlan.findUnique({
    where: { id: planId },
    select: { orderId: true },
  });
  if (!plan) return false;
  return assertOrderVisibleForSupplyChain(userId, role, plan.orderId, department);
}

// ─── 报价 select 构建（底价脱敏）────────────────────────────────
/**
 * 根据角色返回 SupplierQuote 的 select 对象。
 * 非 ADMIN 时排除 floorPriceHint 等敏感字段。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getQuoteSelect(role: string): Record<string, any> {
  const base = {
    id: true,
    supplierId: true,
    // Phase 2 review #2：返回 SKU 身份字段（productSkuId / supplierSkuCode + ProductSku 展示信息）
    productSkuId: true,
    supplierSkuCode: true,
    productSku: {
      select: {
        id: true,
        skuCode: true,
        name: true,
        status: true,
        product: { select: { id: true, productCode: true, name: true } },
      },
    },
    serviceKey: true,
    itemName: true,
    spec: true,
    unit: true,
    minQuantity: true,
    listPrice: true,
    quotedPrice: true,
    negotiatedPrice: true,
    discountRate: true,
    leadDays: true,
    validFrom: true,
    validTo: true,
    lastUpdatedAt: true,
    updateCycleDays: true,
    nextRefreshAt: true,
    status: true,
    source: true,
    sourceRef: true,
    remark: true,
    createdById: true,
    createdAt: true,
    updatedAt: true,
    supplier: { select: { id: true, name: true, shortName: true, status: true } },
  };

  if (canViewFloorPrice(role)) {
    return { ...base, floorPriceHint: true };
  }
  return base;
}

/**
 * 供应商 select——非 ADMIN 排除风险备注、偏好备注等敏感字段。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getSupplierSelect(role: string): Record<string, any> {
  const base = {
    id: true,
    name: true,
    normalizedName: true,
    shortName: true,
    status: true,
    category: true,
    region: true,
    contactName: true,
    phone: true,
    email: true,
    wechat: true,
    address: true,
    contactNote: true,
    paymentCycle: true,
    defaultLeadDays: true,
    quoteUpdateCycleDays: true,
    lastQuoteUpdatedAt: true,
    nextQuoteRefreshAt: true,
    rating: true,
    qualityScore: true,
    deliveryScore: true,
    priceScore: true,
    tagsJson: true,
    archived: true,
    createdAt: true,
    updatedAt: true,
  };

  if (role === "ADMIN") {
    return { ...base, preferenceNote: true, riskNote: true };
  }
  return base;
}
