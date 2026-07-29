import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type DbLike = typeof prisma | Prisma.TransactionClient;

export const CUSTOMER_API_AUDIT_TARGETS = {
  PROFILE_COMPAT: "profile-compat",
  CUSTOMER_LIFECYCLE: "customer-lifecycle",
  ORG_RESOLVER: "org-resolver",
  MERGE_SERVICE: "merge-service",
} as const;

export type CustomerApiAuditTarget =
  (typeof CUSTOMER_API_AUDIT_TARGETS)[keyof typeof CUSTOMER_API_AUDIT_TARGETS];

/**
 * 旧 `/api/customers/**` 审计日志工具（docs/customer-profile-master-migration-2026-06-29.md §9.2）。
 *
 * 职责边界（必须与 `customer-business-fields.ts` 兼容读取层严格分开）：
 * - 本模块只负责【记录】旧 Customer API 的调用，用于 §11.3 审计 burn-down。
 * - 绝不读写 Customer 业务字段、绝不参与 response 组装。
 *
 * 强约束：写审计是 best-effort，任何失败都不能让主请求失败（§9.4 停止条件）。
 * 仅当显式传入 `strict: true`（开发期排障用）才会把错误抛出。
 */
export type CustomerApiAuditInput = {
  /** 旧路由路径，如 `/api/customers/[id]`（用静态模式，不要带真实 id 以便聚合）。 */
  path: string;
  method: string;
  callerUserId?: string | null;
  /** Profile-only：记 profileId 供审计溯源。 */
  profileId?: string | null;
  /** 本次请求触达/读取的业务字段名数组，会序列化成 JSON 存库。 */
  fieldsTouched?: string[] | null;
  /** 兼容层最终把读写转发到了哪里。用稳定枚举，便于 burn-down 聚合。 */
  forwardedTo?: CustomerApiAuditTarget | null;
  /** 可选调用来源提示，如 "customers-page" / "customer-select"。 */
  callerTag?: string | null;
  statusCode?: number | null;
  /** 请求 Referer header（页面来源溯源）。 */
  referer?: string | null;
  /** query key 名白名单拼串（只记 key 名，不记值），如 "search,pageSize"。 */
  queryShape?: string | null;
  /** 请求 User-Agent header。 */
  userAgent?: string | null;
  /** 前端 x-customer-api-caller header，如 "crm-customers-org-filter"。 */
  uiCaller?: string | null;
};

/** query key 白名单：只记这些 key 的【名字】拼串（不记值），用于页面来源溯源。 */
const QUERY_SHAPE_WHITELIST = [
  "search",
  "pageSize",
  "archived",
  "excludeCrm",
  "crmScope",
  "limit",
  "page",
] as const;

/**
 * 从请求中提取审计溯源上下文（referer / user-agent / uiCaller / queryShape）。
 * - referer / userAgent 取自 header，用于页面来源溯源。
 * - uiCaller 取自前端显式传入的 `x-customer-api-caller` header。
 * - queryShape 只保留白名单内出现的 query key【名字】拼串，**绝不记录 value**（避免把
 *   search 关键词等用户输入写进审计）。
 * 纯读 header/URL，无副作用；解析失败一律降级为 null。
 */
export function extractCustomerApiAuditContext(req: Request): {
  referer: string | null;
  userAgent: string | null;
  uiCaller: string | null;
  queryShape: string | null;
} {
  const clip = (v: string | null, max: number) =>
    v && v.length > 0 ? v.slice(0, max) : null;
  const referer = clip(req.headers.get("referer"), 500);
  const userAgent = clip(req.headers.get("user-agent"), 500);
  const uiCaller = clip(req.headers.get("x-customer-api-caller"), 200);
  let queryShape: string | null = null;
  try {
    const params = new URL(req.url).searchParams;
    const keys = QUERY_SHAPE_WHITELIST.filter((k) => params.has(k));
    queryShape = keys.length > 0 ? keys.join(",") : null;
  } catch {
    queryShape = null;
  }
  return { referer, userAgent, uiCaller, queryShape };
}

export async function logCustomerApiAudit(
  _input: CustomerApiAuditInput,
  _db: DbLike = prisma,
  _options: { strict?: boolean } = {},
): Promise<void> {
  // W5.1：停止新写入；历史 CustomerApiAuditLog 行保留不删。
  return;
}
