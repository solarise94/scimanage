/**
 * 定向公海共享授权（部门隔离设计 §4.5 / §8.2）。
 *
 * 认领状态属于目标部门自身；是否允许目标部门看到公海 DTO 由来源部门显式决定。
 * 本模块只写 CrmProfilePoolShare 与审计日志，绝不改写目标部门 state，
 * 也绝不写 FIELD_SALES 旧兼容字段（§8.7：SHARE/REVOKE 不修改旧 assignmentStatus/owner）。
 *
 * 权限映射（第一期最收紧，§4.5）：
 *   - ADMIN：可代任意来源部门操作，但必须显式传 sourceDepartment 并写跨部门审计。
 *   - 来源部门 state 的 active owner：可操作。
 *   - 其余一律拒绝（REGIONAL_MANAGER 明确不在内）。
 *
 * 返回值只含授权记录自身的 status/sharedAt/revokedAt，不返回目标部门是否已认领等信息。
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/application/errors";
import { getActorDepartment, isDepartment, type Department } from "@/lib/department";

type DbLike = typeof prisma | Prisma.TransactionClient;

export type ProfilePoolShareStatus = "ACTIVE" | "REVOKED";

/** 授权记录自身状态；NONE 表示撤回时授权不存在（幂等成功）。 */
export type ProfilePoolShareResult = {
  status: ProfilePoolShareStatus | "NONE";
  sharedAt: Date | null;
  revokedAt: Date | null;
};

/**
 * 是否允许 actor 管理某 profile 从 sourceDepartment 发出的公海共享授权。
 * 路由与 service 必须统一走本函数，不得在路由中散写角色判断。
 */
export async function canManageProfilePoolShare(
  actor: BusinessActor,
  sourceDepartment: string,
  profileId: string,
  db: DbLike = prisma,
): Promise<boolean> {
  if (!isDepartment(sourceDepartment)) return false;
  if (actor.role === "ADMIN") return true;
  // 非 ADMIN 只能以自己数据库中的当前部门作为 sourceDepartment（不信任 JWT/请求体）。
  const actorDepartment = await getActorDepartment(actor.userId);
  if (actorDepartment !== sourceDepartment) return false;
  const state = await db.crmProfileDepartmentState.findUnique({
    where: { profileId_department: { profileId, department: sourceDepartment } },
    select: { claimStatus: true, ownerUserId: true },
  });
  return !!state && state.claimStatus === "CLAIMED" && state.ownerUserId === actor.userId;
}

type ShareLogAction = "SHARE_TO_POOL" | "REVOKE_POOL_SHARE";

/**
 * 事务内部的共享/撤回实现（供 setProfilePoolShare 与 createOrAttachCrmProfile 复用，
 * 调用方必须已完成 source/target 部门校验）。
 */
export async function setProfilePoolShareInTx(
  tx: Prisma.TransactionClient,
  input: {
    actor: BusinessActor;
    profileId: string;
    sourceDepartment: Department;
    targetDepartment: Department;
    shared: boolean;
    /** ADMIN 跨部门代操作时写审计说明。 */
    crossDepartmentByAdmin?: boolean;
  },
): Promise<ProfilePoolShareResult> {
  const { actor, profileId, sourceDepartment, targetDepartment, shared } = input;

  const [sourceState, targetState] = await Promise.all([
    tx.crmProfileDepartmentState.findUnique({
      where: { profileId_department: { profileId, department: sourceDepartment } },
      select: { claimStatus: true, ownerUserId: true },
    }),
    tx.crmProfileDepartmentState.findUnique({
      where: { profileId_department: { profileId, department: targetDepartment } },
      select: { id: true },
    }),
  ]);
  if (!sourceState) throw new NotFoundError("来源部门 state 不存在");
  if (!targetState) throw new NotFoundError("目标部门 state 不存在");

  const allowed = await canManageProfilePoolShare(actor, sourceDepartment, profileId, tx);
  if (!allowed) {
    throw new ForbiddenError("只有来源部门客户负责人或 ADMIN 可以管理公海共享授权");
  }

  const writeLog = async (action: ShareLogAction) => {
    await tx.crmCustomerAssignmentLog.create({
      data: {
        profileId,
        action,
        department: sourceDepartment,
        targetDepartment,
        reason: input.crossDepartmentByAdmin ? "ADMIN 跨部门代操作" : null,
        createdByUserId: actor.userId,
      },
    });
  };

  const now = new Date();
  const existing = await tx.crmProfilePoolShare.findUnique({
    where: {
      profileId_sourceDepartment_targetDepartment: {
        profileId,
        sourceDepartment,
        targetDepartment,
      },
    },
  });

  if (shared) {
    if (sourceState.claimStatus !== "CLAIMED") {
      throw new ConflictError("来源部门未持有该客户（state 非 CLAIMED），不能共享到对方公海");
    }
    let share;
    if (!existing) {
      share = await tx.crmProfilePoolShare.create({
        data: {
          profileId,
          sourceDepartment,
          targetDepartment,
          status: "ACTIVE",
          sharedByUserId: actor.userId,
          sharedAt: now,
        },
      });
    } else {
      // 状态条件更新：并发相反状态更新时 count !== 1 → 409；重复设置为 ACTIVE 幂等
      // （仍刷新 sharedBy/sharedAt、清 revoked 字段，终态同为 ACTIVE）。
      const updated = await tx.crmProfilePoolShare.updateMany({
        where: { id: existing.id, status: existing.status },
        data: {
          status: "ACTIVE",
          sharedByUserId: actor.userId,
          sharedAt: now,
          revokedByUserId: null,
          revokedAt: null,
        },
      });
      if (updated.count !== 1) {
        throw new ConflictError("共享授权已被并发修改，请刷新后重试");
      }
      share = await tx.crmProfilePoolShare.findUniqueOrThrow({ where: { id: existing.id } });
    }
    await writeLog("SHARE_TO_POOL");
    return { status: "ACTIVE", sharedAt: share.sharedAt, revokedAt: share.revokedAt };
  }

  // shared = false（撤回）
  if (!existing) {
    // 不存在授权：幂等成功，不写审计（无实际状态转移）。
    return { status: "NONE", sharedAt: null, revokedAt: null };
  }
  if (existing.status === "REVOKED") {
    // 重复撤回：幂等成功。
    return { status: "REVOKED", sharedAt: existing.sharedAt, revokedAt: existing.revokedAt };
  }
  const updated = await tx.crmProfilePoolShare.updateMany({
    where: { id: existing.id, status: "ACTIVE" },
    data: { status: "REVOKED", revokedByUserId: actor.userId, revokedAt: now },
  });
  if (updated.count !== 1) {
    throw new ConflictError("共享授权已被并发修改，请刷新后重试");
  }
  await writeLog("REVOKE_POOL_SHARE");
  const share = await tx.crmProfilePoolShare.findUniqueOrThrow({ where: { id: existing.id } });
  return { status: "REVOKED", sharedAt: share.sharedAt, revokedAt: share.revokedAt };
}

/**
 * Share / Revoke 事务服务（§8.2）。
 *
 * department 语义：
 *   - 非 ADMIN：sourceDepartment 固定取 actor 数据库当前部门；请求方传入不一致即拒绝。
 *   - ADMIN：必须显式指定 sourceDepartment，targetDepartment 仍必须与 source 不同。
 */
export async function setProfilePoolShare(input: {
  actor: BusinessActor;
  profileId: string;
  sourceDepartment?: string | null;
  targetDepartment: string;
  shared: boolean;
}): Promise<ProfilePoolShareResult> {
  const { actor, profileId, shared } = input;

  if (!isDepartment(input.targetDepartment)) {
    throw new ValidationError(`非法 targetDepartment: ${String(input.targetDepartment)}`);
  }
  const targetDepartment = input.targetDepartment;

  const actorDepartment = await getActorDepartment(actor.userId);
  let sourceDepartment: Department;
  let crossDepartmentByAdmin = false;
  if (actor.role === "ADMIN") {
    if (!input.sourceDepartment || !isDepartment(input.sourceDepartment)) {
      throw new ValidationError("ADMIN 代操作必须显式指定合法的 sourceDepartment");
    }
    sourceDepartment = input.sourceDepartment;
    crossDepartmentByAdmin = sourceDepartment !== actorDepartment;
  } else {
    sourceDepartment = actorDepartment;
    if (input.sourceDepartment && input.sourceDepartment !== sourceDepartment) {
      throw new ForbiddenError("非 ADMIN 只能以本部门作为 sourceDepartment");
    }
  }
  if (sourceDepartment === targetDepartment) {
    throw new ValidationError("sourceDepartment 与 targetDepartment 必须不同");
  }

  return prisma.$transaction(async (tx) => {
    const profile = await tx.crmCustomerProfile.findUnique({
      where: { id: profileId },
      select: { id: true, deleted: true },
    });
    if (!profile || profile.deleted) throw new NotFoundError("Profile not found");
    return setProfilePoolShareInTx(tx, {
      actor,
      profileId,
      sourceDepartment,
      targetDepartment,
      shared,
      crossDepartmentByAdmin,
    });
  });
}
