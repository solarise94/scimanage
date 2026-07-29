/**
 * Shared application-layer identity types and current-actor resolution.
 *
 * Canonical services must accept BusinessActor + InvocationContext only.
 * T9.1c 起 Agent 入口面统一使用 AgentExecutionContext（actor + invocation），
 * 扁平 mixed ActorContext 与 legacy 转换 helper 已全部删除。
 */

import { prisma } from "@/lib/prisma";
import {
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
} from "./errors";
import { assertPortalAccessForActor } from "@/lib/portal/guard";
import { isDepartment } from "@/lib/department";

export type BusinessActor = {
  userId: string;
  role: string;
  /**
   * 不可变部门归属（设计 §三）。非 ADMIN 的 scope 查询必须使用此字段。
   * 可选：未提供时 scope 函数从 DB 实时解析（fail-closed）。
   * 新代码应始终显式传入以避免额外查询。
   */
  department?: string;
  name?: string | null;
  email?: string | null;
};

export type InvocationContext = {
  channel: "web" | "agent";
  agentRunId?: string | null;
  proposalId?: string | null;
  chatSessionId?: string | null;
  idempotencyKey?: string | null;
  /**
   * Phase A public-tool 审计归因：仅由 public executor 服务端注入，
   * 绝不可来自模型/客户端输入。直调 internal action 时为 null。
   */
  publicToolKey?: string | null;
};

export type AgentExecutionContext = {
  actor: BusinessActor;
  invocation: InvocationContext;
};

export type ResolveCurrentBusinessActorInput = {
  userId: string;
  channel: InvocationContext["channel"];
  /** Optional session snapshot; never trusted for role after DB refresh. */
  sessionActor?: Pick<BusinessActor, "name" | "email" | "role"> | null;
  agentRunId?: string | null;
  /** When true (default for agentRunId path), touch AgentRun.lastUsedAt. */
  touchAgentRun?: boolean;
};

function requireUserId(userId: string | null | undefined): string {
  const id = userId?.trim();
  if (!id) {
    throw new UnauthenticatedError("Unauthorized");
  }
  return id;
}

/**
 * Build a BusinessActor from a NextAuth session without DB refresh.
 * Web routes should prefer resolveCurrentBusinessActor when confirming mutations.
 *
 * 同时执行门户准入（设计 §2.4）：非 ADMIN 的 department 必须匹配当前 PORTAL_CODE，
 * 否则抛 PortalAccessDeniedError（403），避免错误门户仅靠隐藏菜单绕过 API。
 */
export function businessActorFromSessionUser(user: {
  id?: string | null;
  role?: string | null;
  department?: string | null;
  name?: string | null;
  email?: string | null;
}): BusinessActor {
  const userId = requireUserId(user.id);
  const role = user.role?.trim();
  if (!role) {
    throw new UnauthenticatedError("Unauthorized");
  }
  const actor: BusinessActor = {
    userId,
    role,
    // Fail-closed（设计 §6.1）：仅接受合法部门值；空或非法时留 undefined，
    // 下游 scope 函数会从 DB 实时解析并按 fail-closed 处理（no-match / 抛错）。
    // 不再静默降级为 FIELD_SALES。
    department: isDepartment(user.department) ? user.department : undefined,
    name: user.name ?? null,
    email: user.email ?? null,
  };
  assertPortalAccessForActor(actor);
  return actor;
}

/**
 * Resolve the current caller identity from the database.
 * Always uses User.role (live), never long-term AgentRun.role snapshots.
 */
export async function resolveCurrentBusinessActor(
  input: ResolveCurrentBusinessActorInput,
): Promise<BusinessActor> {
  const userId = requireUserId(input.userId);

  if (input.agentRunId) {
    const run = await prisma.agentRun.findUnique({
      where: { id: input.agentRunId },
      select: { id: true, userId: true, status: true },
    });
    if (!run) {
      throw new NotFoundError("Agent run not found");
    }
    if (run.userId !== userId) {
      throw new ForbiddenError("Agent run not found");
    }
    if (run.status !== "ACTIVE") {
      throw new ForbiddenError("Agent run is not active");
    }
    if (input.touchAgentRun !== false) {
      await prisma.agentRun.update({
        where: { id: run.id },
        data: { lastUsedAt: new Date() },
      });
    }
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, department: true, name: true, email: true },
  });
  if (!user) {
    throw new UnauthenticatedError("Unauthorized");
  }

  return {
    userId: user.id,
    role: user.role,
    // Fail-closed（设计 §6.1）：仅接受合法部门值；空或非法时留 undefined，
    // 下游 scope 函数会从 DB 实时解析并按 fail-closed 处理（no-match / 抛错）。
    // 不再静默降级为 FIELD_SALES。
    department: isDepartment(user.department) ? user.department : undefined,
    name: user.name ?? input.sessionActor?.name ?? null,
    email: user.email ?? input.sessionActor?.email ?? null,
  };
}

/**
 * 按 userId 读取用户当前角色（T9.1a：proposal 过期回收时刷新 actor 的 canonical 入口，
 * 替换 agent-actions/proposals 内 prisma.user 直连）。用户不存在 -> null。
 */
export async function resolveUserRoleById(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  return user?.role ?? null;
}

export function buildInvocationContext(
  partial: Omit<InvocationContext, "channel"> & { channel: InvocationContext["channel"] },
): InvocationContext {
  return {
    channel: partial.channel,
    agentRunId: partial.agentRunId ?? null,
    proposalId: partial.proposalId ?? null,
    chatSessionId: partial.chatSessionId ?? null,
    idempotencyKey: partial.idempotencyKey ?? null,
    publicToolKey: partial.publicToolKey ?? null,
  };
}

export function buildAgentExecutionContext(
  actor: BusinessActor,
  invocation: InvocationContext,
): AgentExecutionContext {
  return { actor, invocation };
}
