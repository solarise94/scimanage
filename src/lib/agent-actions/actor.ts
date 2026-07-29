import type { Session } from "next-auth";
import {
  businessActorFromSessionUser,
  type BusinessActor,
} from "@/lib/application/actor";
import {
  PortalAccessDeniedError,
  UnauthenticatedError,
} from "@/lib/application/errors";
import { AgentActionError, AgentActionForbiddenError } from "./errors";

/**
 * Web adapter: Session → BusinessActor（T9.1c：取代 deprecated mixed ActorContext）。
 * 需要调用上下文的入口用 buildInvocationContext 自行组装 AgentExecutionContext。
 * 同时执行门户准入（设计 §2.4）：businessActorFromSessionUser 内 assertPortalAccessForActor，
 * 拒绝映射为 403 PORTAL_ACCESS_DENIED（非普通 Error → 500）。
 */
export function requireBusinessActorFromSession(session: Session | null): BusinessActor {
  try {
    return businessActorFromSessionUser({
      id: session?.user?.id,
      role: session?.user?.role,
      department: session?.user?.department,
      name: session?.user?.name,
      email: session?.user?.email,
    });
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      throw new AgentActionForbiddenError("Unauthorized");
    }
    if (err instanceof PortalAccessDeniedError) {
      throw new AgentActionError(err.message, 403, "PORTAL_ACCESS_DENIED");
    }
    throw err;
  }
}
