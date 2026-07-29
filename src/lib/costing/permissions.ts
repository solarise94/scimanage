/**
 * 成本核算模块权限。
 *
 * 设计文档 §权限设计：
 *   ADMIN：全量
 *   USER：可见自己可访问订单/项目/客户的成本
 *   REGIONAL_MANAGER：可见下辖代表相关订单/客户的成本摘要
 *   REPRESENTATIVE：默认不访问
 *
 * Scope 复用供应链模块的 CostEntry scope（订单/项目/客户三路）——
 * 成本与供应方案共享可见性边界。
 */
import { prisma } from "@/lib/prisma";
import { getCostEntryScopeWhere } from "@/lib/supply-chain/permissions";
import { getOrderScopeWhere } from "@/lib/orders/permissions";
import {
  getFinanceProjectScopeWhere,
  getFinanceProfileScopeWhere,
} from "@/lib/finance/permissions";

const COSTING_ACCESS_ROLES = new Set(["ADMIN", "USER", "REGIONAL_MANAGER"]);

export function canAccessCosting(role: string): boolean {
  return COSTING_ACCESS_ROLES.has(role);
}

export function isCostingBlocked(role: string): boolean {
  return !canAccessCosting(role);
}

/**
 * 成本核算 scope——与供应链共享 CostEntry 三路（订单/项目/客户）可见性。
 * getCostEntryScopeWhere 内部已覆盖 ADMIN/USER/REGIONAL_MANAGER。
 */
export async function getCostingScopeWhere(
  userId: string,
  role: string,
  department?: string,
): Promise<Record<string, unknown> | null> {
  if (role === "ADMIN") return null;
  if (!canAccessCosting(role)) {
    return { id: { in: ["__NO_MATCH__"] } };
  }
  return getCostEntryScopeWhere(userId, role, department);
}

/**
 * 校验某 subject（ORDER / PROJECT / CUSTOMER）是否对当前用户可读。
 *
 * 用于 costing/summary、costing/order-margin、costing/customer-margin 等
 * 接受 subjectId / orderId 参数的 API，防止越权枚举 ID 读取成本摘要。
 *
 * ADMIN 全量通过；其他角色复用现有订单/项目/客户 scope 函数逐一校验。
 */
export async function assertSubjectScopeReadable(params: {
  userId: string;
  role: string;
  department?: string;
  subjectType: "ORDER" | "PROJECT" | "CUSTOMER";
  subjectId: string;
}): Promise<boolean> {
  const { userId, role, department, subjectType, subjectId } = params;

  if (role === "ADMIN") return true;

  if (subjectType === "ORDER") {
    const orderScope = await getOrderScopeWhere(userId, role, prisma, department);
    if (!orderScope) return true;
    const visible = await prisma.order.findFirst({
      where: { AND: [orderScope, { id: subjectId, deleted: false }] },
      select: { id: true },
    });
    return !!visible;
  }

  if (subjectType === "PROJECT") {
    const projectScope = await getFinanceProjectScopeWhere(userId, role);
    if (!projectScope) return true;
    return projectScope.id.in.includes(subjectId);
  }

  if (subjectType === "CUSTOMER") {
    const profileScope = await getFinanceProfileScopeWhere(userId, role);
    if (!profileScope) return true;
    return profileScope.id.in.includes(subjectId);
  }

  return false;
}
