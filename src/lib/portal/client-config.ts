/**
 * 客户端 Portal 能力（设计文档 §2.3）。
 *
 * 服务端 Portal 配置在 src/lib/portal/config.ts；客户端组件（如 Sidebar）通过
 * 构建期内联的 NEXT_PUBLIC_PORTAL_CODE 读取当前 Portal，从而按 capability 隐藏
 * 不属于本门户的菜单入口。
 *
 * 重要：菜单隐藏只是产品表面，不是权限边界。API 仍由 assertPortalAccess +
 * 部门校验保护；即使知道另一门户的 URL，API 仍拒绝。
 */

export const CLIENT_PORTAL_CODES = ["FIELD_SALES", "ONLINE_OPS"] as const;
export type ClientPortalCode = (typeof CLIENT_PORTAL_CODES)[number];

export type ClientPortalCapability =
  | "crm-field-visits"
  | "crm-online-service"
  | "customer-service-accounts"
  | "sales-dashboard"
  | "representative-ops";

const CAPABILITIES: Record<ClientPortalCode, ReadonlySet<ClientPortalCapability>> = {
  FIELD_SALES: new Set<ClientPortalCapability>([
    "crm-field-visits",
    "representative-ops",
  ]),
  ONLINE_OPS: new Set<ClientPortalCapability>([
    "crm-online-service",
    "customer-service-accounts",
    "sales-dashboard",
  ]),
};

/**
 * 读取当前客户端 Portal code。
 * 构建期内联；未设时回退 "FIELD_SALES"（与开发环境默认一致，不破坏现有行为）。
 */
export function getClientPortalCode(): ClientPortalCode {
  const code = process.env.NEXT_PUBLIC_PORTAL_CODE;
  if (code && (CLIENT_PORTAL_CODES as readonly string[]).includes(code)) {
    return code as ClientPortalCode;
  }
  return "FIELD_SALES";
}

export function clientPortalHasCapability(
  capability: ClientPortalCapability,
): boolean {
  return CAPABILITIES[getClientPortalCode()].has(capability);
}
