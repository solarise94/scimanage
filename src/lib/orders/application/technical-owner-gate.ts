/**
 * Phase E: technical-owner gate（修正 5 / §2.1）。
 *
 * Agent channel 写门（channel="agent" 时生效；channel="web" 保留既有 role policy）：
 *  - actor 必须是 USER 或 ADMIN（RM 即便 userId 匹配也拒）；
 *  - actor.userId === resource.technicalOwnerUserId；
 *  - technicalOwnerUserId=null → fail-closed（ForbiddenError，提示走 UI 治理）；
 *  - cross-resource（link/合同覆盖多订单/回款跨订单）：每个 affected 资源 owner 都必须匹配。
 *
 * 这个 gate 是 **proposal build 阶段** 与 **最终写事务内** 的双重复核（防 TOCTOU）：
 *  - buildProposal 阶段读 owner 做准入；
 *  - confirm 阶段在最终写事务内 re-fetch owner 复核（owner 可能在两阶段间被改）。
 *
 * Web channel 不调用此 gate（保留既有 role policy；ADMIN UI 例外调整走独立路径）。
 * 这正是同一 canonical command 的显式 channel 策略，不是第二套业务写逻辑。
 *
 * 本模块是 canonical service，允许 Prisma。
 */
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { ForbiddenError } from "@/lib/application/errors";
import type { BusinessActor, InvocationContext } from "@/lib/application/actor";
import { isRegionalManager } from "@/lib/role-guards";

const AGENT_WRITE_ROLES = new Set(["ADMIN", "USER"]);

/**
 * Agent 写门：单个 Order。
 * channel != "agent" 时直接返回（Web 既有 policy）。
 */
export async function assertAgentCanWriteOrder(
  actor: BusinessActor,
  invocation: InvocationContext,
  orderId: string,
  opts?: { tx?: Prisma.TransactionClient },
): Promise<void> {
  if (invocation.channel !== "agent") return;
  assertAgentWriteRole(actor);

  const client = opts?.tx ?? prisma;
  const order = await client.order.findUnique({
    where: { id: orderId },
    select: { id: true, technicalOwnerUserId: true, deleted: true },
  });
  assertOwnerMatches(order?.technicalOwnerUserId ?? null, actor, "订单");
}

/**
 * Agent 写门：单个 Project。
 */
export async function assertAgentCanWriteProject(
  actor: BusinessActor,
  invocation: InvocationContext,
  projectId: string,
  opts?: { tx?: Prisma.TransactionClient },
): Promise<void> {
  if (invocation.channel !== "agent") return;
  assertAgentWriteRole(actor);

  const client = opts?.tx ?? prisma;
  const project = await client.project.findUnique({
    where: { id: projectId },
    select: { id: true, technicalOwnerUserId: true, deleted: true },
  });
  assertOwnerMatches(project?.technicalOwnerUserId ?? null, actor, "项目");
}

/**
 * Agent 写门：多个 Order（cross-resource，如合同覆盖多订单、回款跨订单 allocation）。
 * 每个 affected Order 的 owner 都必须 == actor。
 */
export async function assertAgentCanWriteOrders(
  actor: BusinessActor,
  invocation: InvocationContext,
  orderIds: string[],
  opts?: { tx?: Prisma.TransactionClient },
): Promise<void> {
  if (invocation.channel !== "agent") return;
  if (orderIds.length === 0) return;
  assertAgentWriteRole(actor);

  const client = opts?.tx ?? prisma;
  const orders = await client.order.findMany({
    where: { id: { in: orderIds } },
    select: { id: true, technicalOwnerUserId: true },
  });
  if (orders.length !== orderIds.length) {
    throw new ForbiddenError("部分订单不存在，无法核验技术负责人");
  }
  for (const order of orders) {
    assertOwnerMatches(order.technicalOwnerUserId, actor, `订单 ${order.id}`);
  }
}

/**
 * Agent 写门：多个 Project（cross-resource）。
 */
export async function assertAgentCanWriteProjects(
  actor: BusinessActor,
  invocation: InvocationContext,
  projectIds: string[],
  opts?: { tx?: Prisma.TransactionClient },
): Promise<void> {
  if (invocation.channel !== "agent") return;
  if (projectIds.length === 0) return;
  assertAgentWriteRole(actor);

  const client = opts?.tx ?? prisma;
  const projects = await client.project.findMany({
    where: { id: { in: projectIds } },
    select: { id: true, technicalOwnerUserId: true },
  });
  if (projects.length !== projectIds.length) {
    throw new ForbiddenError("部分项目不存在，无法核验技术负责人");
  }
  for (const project of projects) {
    assertOwnerMatches(project.technicalOwnerUserId, actor, `项目 ${project.id}`);
  }
}

function assertAgentWriteRole(actor: BusinessActor): void {
  if (!AGENT_WRITE_ROLES.has(actor.role)) {
    if (isRegionalManager(actor.role)) {
      // §2.1：RM 即便 userId 恰好等于 technicalOwnerUserId 也不能走 Agent 写。
      throw new ForbiddenError("REGIONAL_MANAGER 不可经 Agent 写订单/项目，即使恰好是技术负责人");
    }
    throw new ForbiddenError("当前角色不可经 Agent 写订单/项目");
  }
}

function assertOwnerMatches(
  technicalOwnerUserId: string | null,
  actor: BusinessActor,
  resourceLabel: string,
): void {
  if (technicalOwnerUserId == null) {
    // fail-closed：无技术负责人 → 走 UI 治理，绝不静默放行。
    throw new ForbiddenError(`${resourceLabel}无技术负责人，请走 UI 治理指派后再经 Agent 操作`);
  }
  if (technicalOwnerUserId !== actor.userId) {
    throw new ForbiddenError(`当前用户不是${resourceLabel}的技术负责人，无法经 Agent 修改`);
  }
}

/**
 * Agent 创建 Order/Project 时：同事务把当前合格 actor 绑定为 technicalOwner。
 * 已由 assertAgentWriteRole 保证 actor 是 USER/ADMIN。
 */
export function agentCreateTechnicalOwnerBinding(
  actor: BusinessActor,
): { technicalOwnerUserId: string } {
  return { technicalOwnerUserId: actor.userId };
}
