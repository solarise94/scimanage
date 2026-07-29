/**
 * 用户部门变更服务（设计 docs/department-isolation-design-2026-07-24.md §5.2）。
 *
 * 仅 ADMIN 可执行部门变更。变更前在同一事务内做前置检查，存在任一未清理项时
 * 抛出 ConflictError 并返回可读提示：
 *   1. 旧部门未完成的 Follow-up（owner=该用户，departmentSnapshot=旧部门，未完成状态）
 *   2. 旧部门已认领（CLAIMED）的 CrmProfileDepartmentState owner
 *   3. 名下有 ACTIVE 的 CustomerServiceAccount
 *   4. 仍是旧部门 Project 的 ProjectMember（Project.departmentSnapshot=旧部门）
 *
 * 用户创建的历史业务快照（Project/Order 等 departmentSnapshot）不随变更改变。
 * 变更写 ActivityLog，记录 from/to department 和操作人；提交后失效 auth context cache。
 *
 * 本服务不直接处理 HTTP；route 层捕获 ApplicationError 后映射为 HTTP 状态码。
 */

import { prisma } from "@/lib/prisma";
import {
  ConflictError,
  ForbiddenError,
  ValidationError,
} from "@/lib/application/errors";
import {
  DEPARTMENT_LABELS,
  isDepartment,
  type Department,
} from "@/lib/department";
import { invalidateUserAuthContext } from "@/lib/user-management/role-cache";

/** CrmFollowUpTask 视为未完成的状态集合（与 schema 注释一致）。 */
const OPEN_FOLLOWUP_STATUSES = new Set(["OPEN", "EXPIRED"]);

export interface ChangeDepartmentActor {
  id: string;
  role: string;
}

export interface ChangeDepartmentResult {
  userId: string;
  fromDepartment: Department;
  toDepartment: Department;
  /** 是否因新旧相同而幂等跳过实际写入与审计。 */
  idempotent: boolean;
}

/**
 * 在事务内执行部门变更前置检查。
 * 任一检查命中即抛 ConflictError，调用方应在事务回滚后将错误映射为 409。
 *
 * 注意：检查仅覆盖「目标用户在旧部门残留的待办」，不修改任何业务快照。
 */
export async function assertUserCanChangeDepartment(
  tx: Parameters<Parameters<typeof prisma["$transaction"]>[0]>[0],
  targetUserId: string,
  oldDepartment: Department,
): Promise<void> {
  // 1. 旧部门未完成的 Follow-up
  const openFollowUps = await tx.crmFollowUpTask.findFirst({
    where: {
      ownerUserId: targetUserId,
      departmentSnapshot: oldDepartment,
      status: { in: [...OPEN_FOLLOWUP_STATUSES] },
    },
    select: { id: true },
  });
  if (openFollowUps) {
    throw new ConflictError(
      `该用户在${DEPARTMENT_LABELS[oldDepartment]}仍有未完成的跟进任务，请先完成或重新指派后再变更部门`,
    );
  }

  // 2. 旧部门 CLAIMED 的 CrmProfileDepartmentState owner
  const claimedStates = await tx.crmProfileDepartmentState.findFirst({
    where: {
      ownerUserId: targetUserId,
      department: oldDepartment,
      claimStatus: "CLAIMED",
    },
    select: { id: true },
  });
  if (claimedStates) {
    throw new ConflictError(
      `该用户在${DEPARTMENT_LABELS[oldDepartment]}仍有已认领客户，请先释放或转派后再变更部门`,
    );
  }

  // 3. 名下 ACTIVE 的 CustomerServiceAccount（首期只有 ONLINE_OPS）
  const activeServiceAccounts = await tx.customerServiceAccount.findFirst({
    where: {
      ownerUserId: targetUserId,
      status: "ACTIVE",
    },
    select: { id: true },
  });
  if (activeServiceAccounts) {
    throw new ConflictError(
      `该用户名下仍有活跃的客服号，请先转派后再变更部门`,
    );
  }

  // 4. 仍是旧部门 Project 的 ProjectMember
  const projectMembership = await tx.projectMember.findFirst({
    where: {
      userId: targetUserId,
      project: { departmentSnapshot: oldDepartment },
    },
    select: { id: true },
  });
  if (projectMembership) {
    throw new ConflictError(
      `该用户仍是${DEPARTMENT_LABELS[oldDepartment]}项目的成员，请先移除成员关系后再变更部门`,
    );
  }
}

/**
 * 变更目标用户的部门。仅 ADMIN 可调用。
 *
 * - isDepartment 校验 newDepartment，非法抛 ValidationError（路由映射 400）。
 * - actor 非 ADMIN 抛 ForbiddenError（403）。
 * - 新旧部门相同时幂等成功，不写审计、不失效缓存。
 * - 事务内执行前置检查 + 写入 + ActivityLog；提交后失效目标用户 auth context cache。
 *
 * 历史业务快照（Project/Order 等 departmentSnapshot）显式保持不变。
 */
export async function changeUserDepartment(opts: {
  actor: ChangeDepartmentActor;
  targetUserId: string;
  newDepartment: string;
}): Promise<ChangeDepartmentResult> {
  if (opts.actor.role !== "ADMIN") {
    throw new ForbiddenError("仅管理员可变更用户部门");
  }

  if (!isDepartment(opts.newDepartment)) {
    throw new ValidationError(`非法部门值: ${opts.newDepartment}`);
  }

  const newDepartment = opts.newDepartment as Department;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({
      where: { id: opts.targetUserId },
      select: { id: true, name: true, department: true },
    });
    if (!existing) {
      throw new ValidationError(`用户 ${opts.targetUserId} 不存在`);
    }

    const oldDepartment: Department = isDepartment(existing.department)
      ? existing.department
      : "FIELD_SALES";

    // 幂等：新旧相同直接成功，不写审计
    if (oldDepartment === newDepartment) {
      return {
        userId: opts.targetUserId,
        fromDepartment: oldDepartment,
        toDepartment: newDepartment,
        idempotent: true,
      };
    }

    // 前置检查（命中即抛 ConflictError → 事务回滚）
    await assertUserCanChangeDepartment(tx, opts.targetUserId, oldDepartment);

    await tx.user.update({
      where: { id: opts.targetUserId },
      data: { department: newDepartment },
      select: { id: true },
    });

    await tx.activityLog.create({
      data: {
        type: "USER_DEPARTMENT_CHANGED",
        content:
          `用户 ${existing.name} 部门从 ${DEPARTMENT_LABELS[oldDepartment]} 变更为 ${DEPARTMENT_LABELS[newDepartment]}` +
          `（操作人 ${opts.actor.id}）`,
        userId: opts.actor.id,
        metadata: JSON.stringify({
          targetUserId: opts.targetUserId,
          fromDepartment: oldDepartment,
          toDepartment: newDepartment,
          actorUserId: opts.actor.id,
        }),
      },
    });

    return {
      userId: opts.targetUserId,
      fromDepartment: oldDepartment,
      toDepartment: newDepartment,
      idempotent: false,
    };
  }).then(async (result) => {
    // 提交后失效目标用户 auth context cache（仅在真正变更时）
    if (!result.idempotent) {
      invalidateUserAuthContext(opts.targetUserId);
    }
    return result;
  });
}
