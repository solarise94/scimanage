/**
 * 共享的 ApplicationError → HTTP NextResponse 映射。
 * Web route 用此 helper；service 只抛具名错误，route 不重复判断状态码。
 */
import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { ApplicationError, PortalAccessDeniedError } from "@/lib/application/errors";

export function mapDomainErrorToHttp(err: unknown, fallbackMsg = "Internal error"): NextResponse {
  if (err instanceof ApplicationError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.httpStatus });
  }
  console.error(fallbackMsg + ":", err);
  return NextResponse.json({ error: fallbackMsg }, { status: 500 });
}

/**
 * 统一 API session 门闩（设计 §2.4）：getServerSession + 门户准入。
 * API 不经 RootLayout，所有敏感 route 应使用本 helper（或 requireActorFromSession），
 * 禁止只读 session 后直接做业务查询。
 */
export async function requirePortalSession(): Promise<
  | { ok: true; session: Session }
  | { ok: false; response: NextResponse }
> {
  const { getServerSession } = await import("next-auth");
  const { authOptions } = await import("@/lib/auth");
  const { assertPortalAccess } = await import("@/lib/portal/guard");
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !session.user.role) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  try {
    assertPortalAccess({
      user: {
        id: session.user.id,
        role: session.user.role,
        department: session.user.department || "",
      },
    });
    return { ok: true, session };
  } catch (err) {
    if (err instanceof PortalAccessDeniedError) {
      return {
        ok: false,
        response: NextResponse.json({ error: err.message, code: err.code }, { status: 403 }),
      };
    }
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
}

/** 从 NextAuth session 构造 BusinessActor，未登录返回 401 NextResponse。 */
export async function requireActorFromSession(): Promise<
  | { ok: true; actor: import("@/lib/application/actor").BusinessActor }
  | { ok: false; response: NextResponse }
> {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated;
  const { businessActorFromSessionUser } = await import("@/lib/application/actor");
  try {
    const actor = businessActorFromSessionUser(gated.session.user);
    return { ok: true, actor };
  } catch (err) {
    if (err instanceof PortalAccessDeniedError) {
      return {
        ok: false,
        response: NextResponse.json({ error: err.message, code: err.code }, { status: 403 }),
      };
    }
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
}
