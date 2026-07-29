/**
 * Portal 配置（设计文档 §2.2）。
 *
 * PORTAL_CODE 只决定产品表面和允许的流程，不能作为记录归属事实源。
 * 写入部门仍取数据库中的 actor.department 或父记录快照。
 */

export const PORTAL_CODES = ["FIELD_SALES", "ONLINE_OPS"] as const;
export type PortalCode = (typeof PORTAL_CODES)[number];

export type PortalCapability =
  | "crm-field-visits"
  | "crm-online-service"
  | "customer-service-accounts"
  | "sales-dashboard"
  | "finance"
  | "supply-chain"
  | "contracts"
  | "agent";

export type PortalConfig = {
  code: PortalCode;
  displayName: string;
  defaultPath: string;
  capabilities: ReadonlySet<PortalCapability>;
  runScheduledJobs: boolean;
};

const PORTAL_CONFIGS: Record<PortalCode, PortalConfig> = {
  FIELD_SALES: {
    code: "FIELD_SALES",
    displayName: process.env.PORTAL_DISPLAY_NAME || "科研项目管理",
    defaultPath: "/dashboard",
    capabilities: new Set([
      "crm-field-visits",
      "finance",
      "supply-chain",
      "contracts",
      "agent",
    ]),
    runScheduledJobs: process.env.PORTAL_RUN_SCHEDULED_JOBS !== "false",
  },
  ONLINE_OPS: {
    code: "ONLINE_OPS",
    displayName: process.env.PORTAL_DISPLAY_NAME || "网络运营工作台",
    defaultPath: "/dashboard",
    capabilities: new Set([
      "crm-online-service",
      "customer-service-accounts",
      "sales-dashboard",
      "finance",
      "supply-chain",
      "agent",
    ]),
    runScheduledJobs: process.env.PORTAL_RUN_SCHEDULED_JOBS === "true",
  },
};

let _cachedConfig: PortalConfig | null = null;

/**
 * 获取当前服务端 Portal 配置。
 *
 * 生产环境 PORTAL_CODE 缺失或非法时启动失败，禁止默认。
 * 开发环境缺省时回退到 FIELD_SALES。
 */
export function getServerPortalConfig(): PortalConfig {
  if (_cachedConfig) return _cachedConfig;

  const code = process.env.PORTAL_CODE;
  const isProduction = process.env.NODE_ENV === "production";

  if (!code || !(PORTAL_CODES as readonly string[]).includes(code)) {
    if (isProduction) {
      throw new Error(
        `PORTAL_CODE 环境变量缺失或非法（收到: "${code}"）。` +
          `生产环境必须设置为 ${PORTAL_CODES.join(" | ")} 之一。`,
      );
    }
    // 开发环境回退
    _cachedConfig = PORTAL_CONFIGS.FIELD_SALES;
    return _cachedConfig;
  }

  _cachedConfig = PORTAL_CONFIGS[code as PortalCode];
  return _cachedConfig;
}

/**
 * 检查当前 Portal 是否具备指定能力。
 */
export function portalHasCapability(capability: PortalCapability): boolean {
  return getServerPortalConfig().capabilities.has(capability);
}
