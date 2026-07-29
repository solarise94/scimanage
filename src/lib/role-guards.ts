/**
 * Client-safe role guard predicates.
 * These are pure functions with no server-only dependencies.
 * Always use explicit allow-lists so undefined role defaults to false.
 */

export function isAdmin(role?: string | null): boolean {
  return role === "ADMIN";
}

export function isInternalStaff(role?: string | null): boolean {
  return role === "ADMIN" || role === "USER";
}

export function isSalesRole(role?: string | null): boolean {
  return role === "REPRESENTATIVE" || role === "REGIONAL_MANAGER";
}

export function isRepresentative(role?: string | null): boolean {
  return role === "REPRESENTATIVE";
}

export function isRegionalManager(role?: string | null): boolean {
  return role === "REGIONAL_MANAGER";
}

/**
 * Agent 入口：
 * - ADMIN：全量工具（调试/验收 + 财务/订单/项目）
 * - USER：订单/项目/工单/财务工具（桌面双栏快速填单）
 * - REPRESENTATIVE：CRM + 工单新建/回复
 * - REGIONAL_MANAGER：下属 scope 的 CRM、订单、财务只读；无写操作
 * 写操作由各 action 的 availability 逐一把控。
 */
export function canAccessAgent(role?: string | null): boolean {
  return role === "ADMIN" || role === "USER" || isSalesRole(role);
}

export function canAccessOrders(role?: string | null): boolean {
  return role === "ADMIN" || role === "USER" || role === "REPRESENTATIVE" || role === "REGIONAL_MANAGER";
}

export function canAccessFinance(role?: string | null): boolean {
  return role === "ADMIN" || role === "USER" || role === "REGIONAL_MANAGER";
}

export function canAccessSupplyChain(role?: string | null): boolean {
  return role === "ADMIN" || role === "USER";
}

export function canAccessCosting(role?: string | null): boolean {
  return role === "ADMIN" || role === "USER" || role === "REGIONAL_MANAGER";
}
