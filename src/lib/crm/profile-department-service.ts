/**
 * CRM 公海认领 / 部门内转派 / 释放 canonical service（部门隔离设计 §8.3 / §8.4 / §8.5）。
 *
 * 不变量：
 *   - 所有写操作在单个 prisma.$transaction 内完成。
 *   - 认领使用 §8.3 单条条件更新（compare-and-set），并发只能一个成功，失败抛 409。
 *   - 只改变当前部门 state；绝不动另一部门 state 与 CrmProfilePoolShare。
 *   - FIELD_SALES state 写入与旧 profile 兼容投影（§8.7）必须同事务；
 *     ONLINE_OPS 操作绝不写旧 profile owner/assignmentStatus 字段。
 *   - 审计写 CrmCustomerAssignmentLog（CLAIM / TRANSFER / RELEASE），
 *     ADMIN 跨部门代操作在 reason 中显式标注。
 */

import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/application/errors";
import { getActorDepartment, isDepartment, type Department } from "@/lib/department";

export type PoolEntryReason = "RELEASED" | "OWNER_UNAVAILABLE";

export type ClaimProfileResult = {
  profileId: string;
  department: Department;
  ownerUserId: string;
  claimedAt: Date;
};

export type TransferProfileResult = {
  profileId: string;
  department: Department;
  fromOwnerUserId: string;
  toOwnerUserId: string;
};

export type ReleaseProfileResult = {
  profileId: string;
  department: Department;
  poolEntryReason: PoolEntryReason;
  releasedAt: Date;
};

/**
 * 解析写操作部门：非 ADMIN 固定取数据库当前部门（忽略 targetDepartment 的跨部门值）；
 * 仅 ADMIN 可为其他部门操作（写跨部门审计）。
 */
async function resolveWriteDepartment(
  actor: BusinessActor,
  targetDepartment?: string | null,
): Promise<{ department: Department; crossDepartmentByAdmin: boolean }> {
  const actorDepartment = await getActorDepartment(actor.userId);
  if (targetDepartment && targetDepartment !== actorDepartment) {
    if (actor.role !== "ADMIN") {
      throw new ForbiddenError("非 ADMIN 不能为其他部门操作");
    }
    if (!isDepartment(targetDepartment)) {
      throw new ValidationError(`非法 targetDepartment: ${String(targetDepartment)}`);
    }
    return { department: targetDepartment, crossDepartmentByAdmin: true };
  }
  if (targetDepartment && !isDepartment(targetDepartment)) {
    throw new ValidationError(`非法 targetDepartment: ${String(targetDepartment)}`);
  }
  return { department: actorDepartment, crossDepartmentByAdmin: false };
}

async function assertProfileExists(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  profileId: string,
): Promise<void> {
  const profile = await tx.crmCustomerProfile.findUnique({
    where: { id: profileId },
    select: { id: true, deleted: true },
  });
  if (!profile || profile.deleted) throw new NotFoundError("Profile not found");
}

/** owner 必须存在且属于目标部门（同事务校验，防 TOCTOU）。 */
async function assertOwnerInDepartment(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  ownerUserId: string,
  department: Department,
): Promise<void> {
  const owner = await tx.user.findUnique({
    where: { id: ownerUserId },
    select: { id: true, department: true },
  });
  if (!owner) throw new ValidationError("负责人不存在");
  if (owner.department !== department) {
    throw new ValidationError("负责人不属于目标部门，不能跨部门认领/转派");
  }
}

const CROSS_DEPT_REASON = "ADMIN 跨部门代操作";

/**
 * 公海认领（§8.3）。本部门公海（poolEntryReason != null）不要求入站授权；
 * 初始隐藏 POOL 必须在更新瞬间仍 JOIN 到 ACTIVE 入站共享授权。
 * count !== 1（已被他人认领 / 授权被并发撤回 / state 已变化）→ 409 并整体回滚。
 */
export async function claimProfileForDepartment(input: {
  actor: BusinessActor;
  profileId: string;
  ownerUserId: string;
  /** 仅 ADMIN 可传，为其他部门操作。 */
  targetDepartment?: string | null;
}): Promise<ClaimProfileResult> {
  const { actor, profileId } = input;
  const ownerUserId = input.ownerUserId?.trim();
  if (!ownerUserId) throw new ValidationError("ownerUserId is required");

  const { department, crossDepartmentByAdmin } = await resolveWriteDepartment(
    actor,
    input.targetDepartment,
  );

  return prisma.$transaction(async (tx) => {
    await assertProfileExists(tx, profileId);
    await assertOwnerInDepartment(tx, ownerUserId, department);

    const now = new Date();
    const claimed = await tx.crmProfileDepartmentState.updateMany({
      where: {
        profileId,
        department,
        claimStatus: "POOL",
        ownerUserId: null,
        OR: [
          { poolEntryReason: { not: null } },
          {
            profile: {
              poolShares: { some: { targetDepartment: department, status: "ACTIVE" } },
            },
          },
        ],
      },
      data: {
        claimStatus: "CLAIMED",
        ownerUserId,
        claimedAt: now,
        claimedById: actor.userId,
        poolEntryReason: null,
        releasedAt: null,
      },
    });
    if (claimed.count !== 1) {
      throw new ConflictError("客户不在可认领的公海状态（可能已被认领或共享授权已撤回）");
    }

    await tx.crmCustomerAssignmentLog.create({
      data: {
        profileId,
        action: "CLAIM",
        department,
        fromOwnerUserId: null,
        toOwnerUserId: ownerUserId,
        reason: crossDepartmentByAdmin ? CROSS_DEPT_REASON : null,
        createdByUserId: actor.userId,
      },
    });

    // §8.7 FIELD_SALES 兼容双写（同事务）；ONLINE_OPS 绝不写旧字段。
    if (department === "FIELD_SALES") {
      await tx.crmCustomerProfile.update({
        where: { id: profileId },
        data: {
          assignmentStatus: "ASSIGNED",
          ownerUserId,
          assignedAt: now,
          assignedByUserId: actor.userId,
          recalledAt: null,
          recalledByUserId: null,
          reflowReason: null,
        },
      });
    }

    return { profileId, department, ownerUserId, claimedAt: now };
  });
}

/**
 * 部门内转派（§8.4）。仅 active owner 或 ADMIN；新 owner 必须同部门；
 * state 保持 CLAIMED；禁止通过本操作跨部门转移（跨部门是两套独立认领状态）。
 */
export async function transferProfileOwnership(input: {
  actor: BusinessActor;
  profileId: string;
  ownerUserId: string;
  targetDepartment?: string | null;
}): Promise<TransferProfileResult> {
  const { actor, profileId } = input;
  const newOwnerUserId = input.ownerUserId?.trim();
  if (!newOwnerUserId) throw new ValidationError("ownerUserId is required");

  const { department, crossDepartmentByAdmin } = await resolveWriteDepartment(
    actor,
    input.targetDepartment,
  );

  return prisma.$transaction(async (tx) => {
    await assertProfileExists(tx, profileId);

    const state = await tx.crmProfileDepartmentState.findUnique({
      where: { profileId_department: { profileId, department } },
      select: { claimStatus: true, ownerUserId: true },
    });
    if (!state) throw new NotFoundError("目标部门 state 不存在");

    const isActiveOwner =
      state.claimStatus === "CLAIMED" && state.ownerUserId === actor.userId;
    if (actor.role !== "ADMIN" && !isActiveOwner) {
      throw new ForbiddenError("只有当前负责人或 ADMIN 可以转派客户");
    }
    if (state.claimStatus !== "CLAIMED" || !state.ownerUserId) {
      throw new ConflictError("客户不在已认领状态，不能转派");
    }
    const fromOwnerUserId = state.ownerUserId;

    await assertOwnerInDepartment(tx, newOwnerUserId, department);

    const updated = await tx.crmProfileDepartmentState.updateMany({
      where: {
        profileId,
        department,
        claimStatus: "CLAIMED",
        ownerUserId: fromOwnerUserId,
      },
      data: { ownerUserId: newOwnerUserId },
    });
    if (updated.count !== 1) {
      throw new ConflictError("客户状态已变化，请刷新后重试");
    }

    await tx.crmCustomerAssignmentLog.create({
      data: {
        profileId,
        action: "TRANSFER",
        department,
        fromOwnerUserId,
        toOwnerUserId: newOwnerUserId,
        reason: crossDepartmentByAdmin ? CROSS_DEPT_REASON : null,
        createdByUserId: actor.userId,
      },
    });

    if (department === "FIELD_SALES") {
      await tx.crmCustomerProfile.update({
        where: { id: profileId },
        data: { ownerUserId: newOwnerUserId },
      });
    }

    return { profileId, department, fromOwnerUserId, toOwnerUserId: newOwnerUserId };
  });
}

/**
 * 释放至本部门公海（§8.5）。仅 active owner 或 ADMIN；
 * CLAIMED/RECALL_CANDIDATE → POOL，清 owner，写 poolEntryReason 与 releasedAt。
 * 释放后进入本部门公海，不再依赖其他部门是否继续共享；
 * 绝不动另一部门 state 与 PoolShare。
 */
export async function releaseProfileToPool(input: {
  actor: BusinessActor;
  profileId: string;
  /** RELEASED（默认，显式释放）| OWNER_UNAVAILABLE（负责人不可用强制解除）。 */
  reason?: PoolEntryReason | null;
  targetDepartment?: string | null;
}): Promise<ReleaseProfileResult> {
  const { actor, profileId } = input;
  const reason: PoolEntryReason = input.reason ?? "RELEASED";
  if (reason !== "RELEASED" && reason !== "OWNER_UNAVAILABLE") {
    throw new ValidationError(`非法释放原因: ${String(input.reason)}`);
  }

  const { department, crossDepartmentByAdmin } = await resolveWriteDepartment(
    actor,
    input.targetDepartment,
  );

  return prisma.$transaction(async (tx) => {
    await assertProfileExists(tx, profileId);

    const state = await tx.crmProfileDepartmentState.findUnique({
      where: { profileId_department: { profileId, department } },
      select: { claimStatus: true, ownerUserId: true },
    });
    if (!state) throw new NotFoundError("目标部门 state 不存在");

    const isActiveOwner =
      (state.claimStatus === "CLAIMED" || state.claimStatus === "RECALL_CANDIDATE") &&
      state.ownerUserId === actor.userId;
    if (actor.role !== "ADMIN" && !isActiveOwner) {
      throw new ForbiddenError("只有当前负责人或 ADMIN 可以释放客户到公海");
    }

    const now = new Date();
    const updated = await tx.crmProfileDepartmentState.updateMany({
      where: {
        profileId,
        department,
        claimStatus: { in: ["CLAIMED", "RECALL_CANDIDATE"] },
      },
      data: {
        claimStatus: "POOL",
        ownerUserId: null,
        poolEntryReason: reason,
        releasedAt: now,
      },
    });
    if (updated.count !== 1) {
      throw new ConflictError("客户不在已认领状态，不能释放（可能已被并发释放）");
    }

    await tx.crmCustomerAssignmentLog.create({
      data: {
        profileId,
        action: "RELEASE",
        department,
        fromOwnerUserId: state.ownerUserId,
        toOwnerUserId: null,
        reason: crossDepartmentByAdmin ? CROSS_DEPT_REASON : reason,
        createdByUserId: actor.userId,
      },
    });

    // §8.7 FIELD_SALES 兼容投影（同事务）；ONLINE_OPS 绝不写旧字段。
    if (department === "FIELD_SALES") {
      await tx.crmCustomerProfile.update({
        where: { id: profileId },
        data:
          reason === "OWNER_UNAVAILABLE"
            ? { assignmentStatus: "UNASSIGNED", ownerUserId: null }
            : {
                assignmentStatus: "RECALLED",
                recalledAt: now,
                recalledByUserId: actor.userId,
              },
      });
    }

    return { profileId, department, poolEntryReason: reason, releasedAt: now };
  });
}
