import { NextResponse } from "next/server";
import type { Session } from "next-auth";

import { canAccessAgent } from "@/lib/role-guards";

/**
 * 服务端 Agent 入口角色门（AGENTS review P1#2）。
 *
 * 产品边界与页面侧 `canAccessAgent(role)` 对齐：
 * ADMIN / USER / REPRESENTATIVE / REGIONAL_MANAGER 可进。
 * 细粒度工具开放与数据可见性由各 action 的 `availability` + execute 内 scope 守门。
 *
 * 用法（route 内，`getServerSession` 之后、业务逻辑之前）：
 * ```ts
 * const session = await getServerSession(authOptions);
 * const denied = requireAgentAccess(session);
 * if (denied) return denied;
 * ```
 *
 * @returns `null` = 放行；非 null = 已构造好的 401/403 响应，route 直接 return。
 *   - null session → 401
 *   - role 不在 canAccessAgent 白名单 → 403
 */
export function requireAgentAccess(session: Session | null): NextResponse | null {
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // role 由 src/lib/auth.ts 的 next-auth 模块增强声明；scripts 工程可能未拉取该声明，
  // 因此这里用窄化读取，避免 typecheck:scripts 误报。
  const role =
    session.user && "role" in session.user
      ? (session.user as { role?: string | null }).role
      : null;
  if (!canAccessAgent(role)) {
    return NextResponse.json({ error: "Agent 暂未对你开放" }, { status: 403 });
  }
  return null;
}
