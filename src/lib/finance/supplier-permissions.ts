/**
 * 财务供应商付款模块权限。
 *
 * 付款状态只属于财务模块。设计文档 §权限设计：
 *   ADMIN：全量（canViewPaymentSummary = true）
 *   USER：可访问但不查看付款汇总
 *   REGIONAL_MANAGER / REPRESENTATIVE：默认不访问
 *
 * 部门隔离（设计 §6.5）：FinancePayable / FinancePayment 按自身 departmentSnapshot
 * 过滤。FinancePayable 可关联共享 Supplier，但部门隔离发生在执行记录（应付/付款）上，
 * 不在共享 Supplier 上加部门字段；USER 创建的无订单应付也带部门快照，
 * 不能因 createdById 放宽到跨部门。
 */
import { isDepartment, resolveActorDepartmentOrNull } from "@/lib/department";

const SUPPLIER_PAYMENT_ACCESS_ROLES = new Set(["ADMIN", "USER"]);

export function canAccessSupplierPayments(role: string): boolean {
  return SUPPLIER_PAYMENT_ACCESS_ROLES.has(role);
}

export function isSupplierPaymentBlocked(role: string): boolean {
  return !canAccessSupplierPayments(role);
}

export function canViewPaymentSummary(role: string): boolean {
  return role === "ADMIN";
}

/**
 * 解析非 ADMIN 用户的部门。Fail-closed（设计 §6.1）：
 * 显式传入时仅接受合法部门值；未传入时从 DB 实时解析。
 * 用户不存在或 department 非法时返回 null，调用点据此返回 no-match scope，
 * 不再静默降级为 FIELD_SALES。
 */
async function resolveSupplierPaymentDepartment(
  userId: string,
  department?: string,
): Promise<string | null> {
  if (department) {
    return isDepartment(department) ? department : null;
  }
  return resolveActorDepartmentOrNull(userId);
}

/**
 * FinancePayable / FinancePayment scope——按自身 departmentSnapshot 隔离。
 * 设计 §6.5：FinancePayable / FinancePayment 按自身快照及分摊一致性过滤。
 * ADMIN 全量；USER 看本部门应付/付款；其他角色拒绝。
 */
export async function getSupplierPaymentScopeWhere(
  userId: string,
  role: string,
  department?: string,
): Promise<Record<string, unknown> | null> {
  if (role === "ADMIN") return null;
  if (!canAccessSupplierPayments(role)) {
    return { id: { in: ["__NO_MATCH__"] } };
  }

  const resolvedDepartment = await resolveSupplierPaymentDepartment(userId, department);
  // Fail-closed（设计 §6.1）：部门无法权威解析时返回 no-match，不静默降级为 FIELD_SALES。
  if (!resolvedDepartment) {
    return { id: { in: ["__NO_MATCH__"] } };
  }
  // 设计 §6.5：按自身快照过滤；不再用 createdById 兜底（会放宽跨部门）。
  return { departmentSnapshot: resolvedDepartment };
}
