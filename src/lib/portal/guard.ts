/**
 * Portal 准入守卫（设计文档 §2.4）。
 *
 * 登录和每次敏感 API 请求同时检查：
 * - ADMIN → 可进入两个门户
 * - 非 ADMIN 且 user.department == PORTAL_CODE → 允许
 * - 非 ADMIN 且不相等 → 403 / 引导到正确门户
 */

import { PortalAccessDeniedError } from "@/lib/application/errors";
import type { PortalConfig } from "./config";
import { getServerPortalConfig } from "./config";

export type PortalSession = {
  user: {
    id: string;
    role: string;
    department: string;
  };
};

export type PortalActor = {
  role: string;
  department?: string | null;
};

/**
 * 断言当前 session 有权访问当前 Portal。
 * 在根布局、核心 API/Agent 入口和后台 job 共用。
 *
 * @throws PortalAccessDeniedError (403 / PORTAL_ACCESS_DENIED)
 */
export function assertPortalAccess(
  session: PortalSession,
  portalConfig?: PortalConfig,
): void {
  assertPortalAccessForActor(session.user, portalConfig);
}

/**
 * 对 BusinessActor / session user 形态做门户准入校验。
 */
export function assertPortalAccessForActor(
  actor: PortalActor,
  portalConfig?: PortalConfig,
): void {
  const config = portalConfig ?? getServerPortalConfig();
  const { role, department } = actor;

  // ADMIN 可进入两个门户
  if (role === "ADMIN") return;

  const dept = typeof department === "string" ? department.trim() : "";
  // 非 ADMIN：department 必须匹配当前 Portal code
  if (!dept || dept !== config.code) {
    throw new PortalAccessDeniedError(
      `当前账号属于 ${dept || "未知部门"}，无权访问 ${config.displayName}（${config.code}）门户`,
    );
  }
}

/**
 * 检查当前 session 是否有权访问当前 Portal（不抛异常版本）。
 */
export function canAccessPortal(
  session: PortalSession,
  portalConfig?: PortalConfig,
): boolean {
  try {
    assertPortalAccess(session, portalConfig);
    return true;
  } catch {
    return false;
  }
}

export function canActorAccessPortal(
  actor: PortalActor,
  portalConfig?: PortalConfig,
): boolean {
  try {
    assertPortalAccessForActor(actor, portalConfig);
    return true;
  } catch {
    return false;
  }
}
