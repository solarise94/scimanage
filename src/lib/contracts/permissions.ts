import { isSalesRole } from "@/lib/role-guards";
import { getOrderScopeWhere } from "@/lib/orders/permissions";
import { prisma } from "@/lib/prisma";

// 模板管理：仅 ADMIN
export function canManageTemplates(role: string): boolean {
  return role === "ADMIN";
}

// 模板查看（列表/详情）：非销售角色（ADMIN/USER）
export function canViewTemplates(role: string): boolean {
  return !isSalesRole(role);
}

// 合同生成：仅内部员工（ADMIN/USER），销售角色（REPRESENTATIVE/REGIONAL_MANAGER）→ false
// 统一用 isSalesRole()，后端 API 和前端按钮同源
export function canGenerateContract(role: string): boolean {
  return !isSalesRole(role);
}

// 合同查看/下载：能访问订单的人即可（含销售角色只读）
export async function canAccessOrder(
  orderId: string,
  userId: string,
  role: string,
  department?: string,
): Promise<boolean> {
  if (role === "ADMIN") return true;
  const scopeWhere = await getOrderScopeWhere(userId, role, prisma, department);
  if (!scopeWhere) return true; // 无 scope 限制
  const count = await prisma.order.count({
    where: { AND: [scopeWhere, { id: orderId }, { deleted: false }] },
  });
  return count > 0;
}
