/**
 * CRM 公海/认领路由层共享 helper（部门隔离设计 Phase 4 §8.2-8.7）。
 *
 * 仅服务端 Next.js route 使用：
 *   - 从 NextAuth session 构造 BusinessActor（不触发 Portal 守卫——route 自身权限
 *     判断完全在服务端，部门隔离 access resolver 已收敛所有可见性）。
 *   - 把 typed ApplicationError 映射为 JSON 响应（参照仓库现有 route 错误映射惯例）。
 *
 * 不 import Next，便于在临时 SQLite 测试中直接调用 route handler。
 */

import { NextResponse } from "next/server";
import type { BusinessActor } from "@/lib/application/actor";
import { ApplicationError, UnauthenticatedError } from "@/lib/application/errors";

type SessionUser = {
  id?: string | null;
  role?: string | null;
  department?: string | null;
  name?: string | null;
  email?: string | null;
};

type SessionLike = { user?: SessionUser } | null;

/**
 * 校验 session 已登录，返回 BusinessActor。
 * 缺失/角色空 → 抛 UnauthenticatedError（由 mapApplicationError 转 401）。
 *
 * 与 businessActorFromSessionUser 的区别：不调用 assertPortalAccessForActor，
 * 因为这些 route 的权限收敛在 resolveCrmProfileAccess / canonical service；
 * 门户准入在根布局与登录链路完成，route 不重复。
 */
export function requireCrmActor(session: SessionLike): BusinessActor {
  const user = session?.user;
  if (!user) {
    throw new UnauthenticatedError("Unauthorized");
  }
  const userId = user.id?.trim();
  const role = user.role?.trim();
  if (!userId || !role) {
    throw new UnauthenticatedError("Unauthorized");
  }
  return {
    userId,
    role,
    department: user.department?.trim() || undefined,
    name: user.name ?? null,
    email: user.email ?? null,
  };
}

/** 401 短路：未登录直接返回 JSON。 */
export function unauthorizedResponse(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * 把 typed ApplicationError 映射为 JSON 响应。
 * 非 ApplicationError 重新抛出（由 Next.js 500 兜底）。
 */
export function mapApplicationError(err: unknown): NextResponse {
  if (err instanceof ApplicationError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.httpStatus });
  }
  throw err;
}

/**
 * 解析 profile 访问级别并执行标准 404/403 短路。
 * 返回 access level；NONE → 404（防存在性泄露），其余由调用方继续。
 */
export type CrmRouteHandoff<T> =
  | { ok: true; actor: BusinessActor; access: T }
  | { ok: false; response: NextResponse };

export { ApplicationError };
