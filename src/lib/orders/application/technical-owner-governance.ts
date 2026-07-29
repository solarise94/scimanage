/**
 * Phase E: technical-owner governance（修正 5）。
 *
 * 回填规则（严格）：
 *  - Order.techSupport 是展示字段，但不能单独作为 Agent 授权依据；历史 owner 缺失
 *    的订单仍全部进入 PENDING 队列，不从关联 Project 推导 owner。
 *  - Project.techSupport 字符串：仅当精确唯一匹配单个 User.name（且该 User 是内部员工
 *    USER/ADMIN）时自动回填 RESOLVED_AUTO；空/未匹配/歧义/匹配到非员工 → PENDING。
 *  - @@unique([resourceType, resourceId]) 防同一资源重复建任务。
 *
 * Agent 写任何 technicalOwnerUserId=null 的资源 → fail-closed（见 owner-gate.ts）。
 *
 * 本模块是 canonical service（src/lib/orders/application/**），允许 Prisma。
 */
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

const INTERNAL_STAFF_ROLES = new Set(["ADMIN", "USER"]);

export type GovernanceResourceType = "ORDER" | "PROJECT";

export interface BackfillResult {
  autoResolved: number;
  pending: number;
  ambiguous: number;
  empty: number;
  noInternalMatch: number;
  alreadyResolved: number;
}

/**
 * 为所有 technicalOwnerUserId=null 的 Order 建 PENDING 治理任务。
 * Order.techSupport 仅是展示字段，不能安全推导 Agent 写授权。
 */
export async function backfillOrderGovernanceTasks(): Promise<BackfillResult> {
  const orders = await prisma.order.findMany({
    where: { technicalOwnerUserId: null, deleted: false },
    select: { id: true },
  });

  let pending = 0;
  let alreadyResolved = 0;
  for (const order of orders) {
    // 检查是否已有任务（含 RESOLVED 的，避免重复）
    const existing = await prisma.technicalOwnerGovernanceTask.findUnique({
      where: { resourceType_resourceId: { resourceType: "ORDER", resourceId: order.id } },
      select: { status: true },
    });
    if (existing) {
      if (existing.status !== "PENDING") alreadyResolved++;
      continue;
    }
    await prisma.technicalOwnerGovernanceTask.create({
      data: {
        resourceType: "ORDER",
        resourceId: order.id,
        legacyDisplayName: null,
        status: "PENDING",
        reason: "EMPTY",
      },
    });
    pending++;
  }

  return {
    autoResolved: 0,
    pending,
    ambiguous: 0,
    empty: pending,
    noInternalMatch: 0,
    alreadyResolved,
  };
}

/**
 * 为所有 technicalOwnerUserId=null 的 Project 尝试精确唯一姓名回填。
 * 仅当 Project.techSupport 精确匹配唯一内部员工（USER/ADMIN）User.name 时自动回填。
 */
export async function backfillProjectGovernanceTasks(): Promise<BackfillResult> {
  const projects = await prisma.project.findMany({
    where: { technicalOwnerUserId: null, deleted: false },
    select: { id: true, techSupport: true },
  });

  // 收集所有非空 techSupport 名，批量查 User（内部员工）。
  const names = projects
    .map((p) => p.techSupport?.trim())
    .filter((n): n is string => !!n && n.length > 0);
  const uniqueNames = [...new Set(names)];

  const nameToUsers = new Map<string, Array<{ id: string; role: string; name: string }>>();
  if (uniqueNames.length > 0) {
    const users = await prisma.user.findMany({
      where: { name: { in: uniqueNames }, role: { in: [...INTERNAL_STAFF_ROLES] } },
      select: { id: true, role: true, name: true },
    });
    for (const u of users) {
      const list = nameToUsers.get(u.name) ?? [];
      list.push(u);
      nameToUsers.set(u.name, list);
    }
  }

  let autoResolved = 0;
  let pending = 0;
  let ambiguous = 0;
  let empty = 0;
  let noInternalMatch = 0;
  let alreadyResolved = 0;

  for (const project of projects) {
    const existing = await prisma.technicalOwnerGovernanceTask.findUnique({
      where: { resourceType_resourceId: { resourceType: "PROJECT", resourceId: project.id } },
      select: { status: true },
    });
    if (existing) {
      if (existing.status !== "PENDING") alreadyResolved++;
      continue;
    }

    const name = project.techSupport?.trim();
    if (!name) {
      await prisma.technicalOwnerGovernanceTask.create({
        data: {
          resourceType: "PROJECT",
          resourceId: project.id,
          legacyDisplayName: null,
          status: "PENDING",
          reason: "EMPTY",
        },
      });
      empty++;
      pending++;
      continue;
    }

    const matches = nameToUsers.get(name) ?? [];
    if (matches.length === 0) {
      await prisma.technicalOwnerGovernanceTask.create({
        data: {
          resourceType: "PROJECT",
          resourceId: project.id,
          legacyDisplayName: name,
          status: "PENDING",
          reason: "NO_INTERNAL_MATCH",
        },
      });
      noInternalMatch++;
      pending++;
      continue;
    }
    if (matches.length > 1) {
      await prisma.technicalOwnerGovernanceTask.create({
        data: {
          resourceType: "PROJECT",
          resourceId: project.id,
          legacyDisplayName: name,
          status: "PENDING",
          reason: "AMBIGUOUS",
        },
      });
      ambiguous++;
      pending++;
      continue;
    }

    // 精确唯一匹配 → 自动回填 + 建 RESOLVED_AUTO 任务（同事务）。
    const matchedUser = matches[0];
    await prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: project.id },
        data: { technicalOwnerUserId: matchedUser.id },
      });
      await tx.technicalOwnerGovernanceTask.create({
        data: {
          resourceType: "PROJECT",
          resourceId: project.id,
          legacyDisplayName: name,
          status: "RESOLVED_AUTO",
          resolvedUserId: matchedUser.id,
          resolvedAt: new Date(),
          reason: "EXACT_UNIQUE_MATCH",
        },
      });
    });
    autoResolved++;
  }

  return { autoResolved, pending, ambiguous, empty, noInternalMatch, alreadyResolved };
}

/**
 * ADMIN 在 UI 手工指派 technicalOwner。
 * Order：更新 technicalOwnerUserId；Project：更新 + 同事务确保 ProjectMember（MEMBER 非 OWNER）。
 * 标记治理任务 RESOLVED_MANUAL。
 */
export async function assignTechnicalOwnerManual(opts: {
  /** 执行操作的 ADMIN（审计用；当前实现未落审计行，保留参数便于后续扩展）。 */
  actorUserId: string;
  resourceType: GovernanceResourceType;
  resourceId: string;
  targetUserId: string;
}): Promise<void> {
  const { resourceType, resourceId, targetUserId } = opts;
  void opts.actorUserId; // 审计扩展占位

  // 校验 target 是内部员工。
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, role: true, name: true, email: true },
  });
  if (!target || !INTERNAL_STAFF_ROLES.has(target.role)) {
    throw new Error("技术负责人必须是内部员工（USER 或 ADMIN）");
  }

  await prisma.$transaction(async (tx) => {
    if (resourceType === "ORDER") {
      const displayName = target.name?.trim() || target.email.split("@")[0]?.trim();
      if (!displayName) {
        throw new Error("技术负责人缺少可用姓名，无法同步订单技术支持");
      }
      await tx.order.update({
        where: { id: resourceId },
        data: { technicalOwnerUserId: targetUserId, techSupport: displayName },
      });
    } else {
      await tx.project.update({
        where: { id: resourceId },
        data: { technicalOwnerUserId: targetUserId },
      });
      // Project：同事务确保 ProjectMember（MEMBER，非 OWNER，避免误授项目管理权）。
      // 修正 5：技术负责人写权以 FK 为准；ProjectMember MEMBER 只是保持 project-scope 语义。
      const existingMember = await tx.projectMember.findUnique({
        where: { projectId_userId: { projectId: resourceId, userId: targetUserId } },
        select: { id: true },
      });
      if (!existingMember) {
        await tx.projectMember.create({
          data: { projectId: resourceId, userId: targetUserId, role: "MEMBER" },
        });
      }
    }

    // upsert 治理任务（可能不存在，如新资源直接被指派）。
    await tx.technicalOwnerGovernanceTask.upsert({
      where: { resourceType_resourceId: { resourceType, resourceId } },
      update: {
        status: "RESOLVED_MANUAL",
        resolvedUserId: targetUserId,
        resolvedAt: new Date(),
        reason: "MANUAL_ASSIGN",
      },
      create: {
        resourceType,
        resourceId,
        status: "RESOLVED_MANUAL",
        resolvedUserId: targetUserId,
        resolvedAt: new Date(),
        reason: "MANUAL_ASSIGN",
      },
    });
  });
}

/** 列出 PENDING 治理任务（ADMIN UI 用）。 */
export async function listPendingGovernanceTasks(opts: {
  resourceType?: GovernanceResourceType;
  limit?: number;
}): Promise<{
  tasks: Array<{
    id: string;
    resourceType: string;
    resourceId: string;
    legacyDisplayName: string | null;
    reason: string | null;
    createdAt: Date;
  }>;
  total: number;
}> {
  const where: Prisma.TechnicalOwnerGovernanceTaskWhereInput = { status: "PENDING" };
  if (opts.resourceType) where.resourceType = opts.resourceType;
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));

  const [tasks, total] = await Promise.all([
    prisma.technicalOwnerGovernanceTask.findMany({
      where,
      orderBy: { createdAt: "asc" },
      take: limit,
      select: {
        id: true,
        resourceType: true,
        resourceId: true,
        legacyDisplayName: true,
        reason: true,
        createdAt: true,
      },
    }),
    prisma.technicalOwnerGovernanceTask.count({ where }),
  ]);

  return { tasks, total };
}
