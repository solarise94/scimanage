/**
 * PRJ-OTHER 治理桶 service（设计文档 §8）。
 *
 * 治理桶不是普通财务项目：
 *  - 只用于无法可靠归属的历史项目/导入记录；
 *  - 不通过普通 OrderProjectLink 参与项目收入/成本/开票/进度汇总；
 *  - 普通业务一旦识别出真实项目，应从治理桶中解除并绑定真实项目。
 *
 * 本模块是 canonical service，允许 Prisma。
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/application/errors";
import { DEFAULT_DEPARTMENT, isDepartment, type Department } from "@/lib/department";
import { getOrderScopeWhere } from "@/lib/orders/permissions";
import { canReadProject } from "@/lib/permissions";
import {
  GENERAL_OTHER_PROJECT,
  GOVERNANCE_PROJECT_SYSTEM_TYPE,
  GOVERNANCE_REASON_CODE,
} from "@/lib/products/constants";

type DbLike = typeof prisma | Prisma.TransactionClient;

/**
 * 幂等获取 PRJ-OTHER 治理桶。不存在则创建（仅 ADMIN）。
 * 用于历史导入与治理任务创建 assignment。
 */
export async function ensureGeneralOtherProject(actor: BusinessActor): Promise<{
  id: string;
  projectNo: string | null;
  name: string;
  systemType: string;
  systemKey: string | null;
}> {
  if (actor.role !== "ADMIN" && actor.role !== "USER") {
    throw new ForbiddenError("仅内部员工可操作治理桶");
  }

  const existing = await prisma.project.findUnique({
    where: { systemKey: GENERAL_OTHER_PROJECT.SYSTEM_KEY },
    select: { id: true, projectNo: true, name: true, systemType: true, systemKey: true },
  });
  if (existing) return existing;

  // 创建治理桶：projectNo=PRJ-OTHER，不进普通序列；systemType=GOVERNANCE_BUCKET。
  // 注意 systemKey @unique 保证全局唯一。
  const created = await prisma.project.create({
    data: {
      projectNo: GENERAL_OTHER_PROJECT.PROJECT_NO,
      name: GENERAL_OTHER_PROJECT.NAME,
      systemType: GENERAL_OTHER_PROJECT.SYSTEM_TYPE,
      systemKey: GENERAL_OTHER_PROJECT.SYSTEM_KEY,
      profileId: null, // 治理桶无客户
      status: "NOT_STARTED",
      description: "历史治理桶：仅用于无法可靠归属的导入/历史记录，不计入任何业务统计。",
    },
    select: { id: true, projectNo: true, name: true, systemType: true, systemKey: true },
  });
  return created;
}

/**
 * 获取治理桶（只读），不存在则返回 null。用于非创建场景。
 */
export async function findGeneralOtherProject(): Promise<{
  id: string;
  projectNo: string | null;
  systemKey: string | null;
} | null> {
  const p = await prisma.project.findUnique({
    where: { systemKey: GENERAL_OTHER_PROJECT.SYSTEM_KEY },
    select: { id: true, projectNo: true, systemKey: true },
  });
  return p;
}

export interface CreateGovernanceAssignmentInput {
  governanceProjectId?: string; // 默认 PRJ-OTHER
  legacyProjectId?: string | null;
  orderId?: string | null;
  sourceRecordId?: string | null;
  reasonCode: string;
  note?: string | null;
}

async function resolveActorDepartmentLive(
  db: DbLike,
  actor: BusinessActor,
): Promise<Department> {
  const user = await db.user.findUnique({
    where: { id: actor.userId },
    select: { department: true },
  });
  // Fail-closed（设计 §6.1）：用户不存在或 department 非法时拒绝，不静默降级为 FIELD_SALES。
  if (!user || !isDepartment(user.department)) {
    throw new ForbiddenError("无法权威解析操作者部门");
  }
  return user.department;
}

/**
 * 解析 subject 的不可变部门快照，并校验非 ADMIN 对 subject 的可读 scope。
 * 跨部门 / 不可读统一映射为 NotFound（防存在性泄露）。
 */
async function resolveSubjectDepartment(
  db: DbLike,
  actor: BusinessActor,
  input: CreateGovernanceAssignmentInput,
  actorDepartment: Department,
): Promise<{ subjectKey: string; departmentId: Department }> {
  if (input.legacyProjectId) {
    const project = await db.project.findUnique({
      where: { id: input.legacyProjectId },
      select: { id: true, departmentSnapshot: true },
    });
    if (!project) throw new NotFoundError("legacyProjectId 对应的项目");
    const dept = isDepartment(project.departmentSnapshot)
      ? project.departmentSnapshot
      : DEFAULT_DEPARTMENT;
    if (actor.role !== "ADMIN") {
      const readable = await canReadProject(
        project.id,
        actor.userId,
        actor.role,
        db,
        actorDepartment,
      );
      if (!readable || dept !== actorDepartment) {
        throw new NotFoundError("legacyProjectId 对应的项目");
      }
    }
    return { subjectKey: `legacyProject:${project.id}`, departmentId: dept };
  }

  if (input.orderId) {
    const order = await db.order.findUnique({
      where: { id: input.orderId },
      select: { id: true, departmentSnapshot: true, deleted: true },
    });
    if (!order || order.deleted) throw new NotFoundError("orderId 对应的订单");
    const dept = isDepartment(order.departmentSnapshot)
      ? order.departmentSnapshot
      : DEFAULT_DEPARTMENT;
    if (actor.role !== "ADMIN") {
      if (dept !== actorDepartment) {
        throw new NotFoundError("orderId 对应的订单");
      }
      const scope = await getOrderScopeWhere(actor.userId, actor.role, db, actorDepartment);
      if (scope) {
        const visible = await db.order.findFirst({
          where: { AND: [scope, { id: order.id, deleted: false }] },
          select: { id: true },
        });
        if (!visible) throw new NotFoundError("orderId 对应的订单");
      }
    }
    return { subjectKey: `order:${order.id}`, departmentId: dept };
  }

  if (input.sourceRecordId) {
    const sr = await db.orderSourceRecord.findUnique({
      where: { id: input.sourceRecordId },
      select: {
        id: true,
        orderId: true,
        order: { select: { id: true, departmentSnapshot: true, deleted: true } },
      },
    });
    if (!sr) throw new NotFoundError("sourceRecordId 对应的来源记录");
    if (!sr.order || sr.order.deleted) {
      throw new ValidationError("来源记录未绑定有效订单，无法确定部门归属");
    }
    const dept = isDepartment(sr.order.departmentSnapshot)
      ? sr.order.departmentSnapshot
      : DEFAULT_DEPARTMENT;
    if (actor.role !== "ADMIN") {
      if (dept !== actorDepartment) {
        throw new NotFoundError("sourceRecordId 对应的来源记录");
      }
      const scope = await getOrderScopeWhere(actor.userId, actor.role, db, actorDepartment);
      if (scope) {
        const visible = await db.order.findFirst({
          where: { AND: [scope, { id: sr.order.id, deleted: false }] },
          select: { id: true },
        });
        if (!visible) throw new NotFoundError("sourceRecordId 对应的来源记录");
      }
    }
    return { subjectKey: `sourceRecord:${sr.id}`, departmentId: dept };
  }

  throw new ValidationError("subject 校验失败");
}

/**
 * 创建治理 assignment（设计文档 §8.3）。
 * 治理关系只回答"这条历史记录当前还没有可靠真实项目归属，暂放哪个治理队列"。
 *
 * 同事务内：解析 actor 部门、校验 subject 可读 scope、写入 departmentId。
 */
export async function createGovernanceAssignmentForActor(
  actor: BusinessActor,
  input: CreateGovernanceAssignmentInput,
) {
  if (actor.role !== "ADMIN" && actor.role !== "USER") {
    throw new ForbiddenError("仅内部员工可创建治理 assignment");
  }
  if (!Object.values(GOVERNANCE_REASON_CODE).includes(input.reasonCode as never)) {
    throw new ValidationError(`无效 reasonCode: ${input.reasonCode}`);
  }

  // P2 修正（review #7）：治理 assignment 必须恰好关联一个治理对象（exactly-one），
  // 避免产生无法定位的空治理任务。
  const subjects = [input.legacyProjectId, input.orderId, input.sourceRecordId].filter(
    (s): s is string => typeof s === "string" && s.trim().length > 0,
  );
  if (subjects.length === 0) {
    throw new ValidationError(
      "治理 assignment 必须关联恰好一个对象（legacyProjectId / orderId / sourceRecordId）",
    );
  }
  if (subjects.length > 1) {
    throw new ValidationError(
      "治理 assignment 只能关联一个对象（legacyProjectId / orderId / sourceRecordId 三选一）",
    );
  }

  // 治理桶可在事务外幂等确保（systemKey 唯一）；主体校验与写入同事务。
  let governanceProjectId = input.governanceProjectId;
  if (!governanceProjectId) {
    const bucket = await ensureGeneralOtherProject(actor);
    governanceProjectId = bucket.id;
  } else {
    const gp = await prisma.project.findUnique({
      where: { id: governanceProjectId },
      select: { systemType: true },
    });
    if (!gp) throw new NotFoundError("治理桶项目");
    if (gp.systemType !== GOVERNANCE_PROJECT_SYSTEM_TYPE.GOVERNANCE_BUCKET) {
      throw new ValidationError("目标项目不是治理桶");
    }
  }

  const bucketId = governanceProjectId;

  try {
    return await prisma.$transaction(async (tx) => {
      const actorDepartment = await resolveActorDepartmentLive(tx, actor);
      const { subjectKey, departmentId } = await resolveSubjectDepartment(
        tx,
        actor,
        input,
        actorDepartment,
      );

      // review #5/#6：并发安全幂等——先查 active（OPEN），存在则返回；否则创建。
      const existing = await tx.projectGovernanceAssignment.findUnique({
        where: {
          governanceProjectId_activeSubjectKey: {
            governanceProjectId: bucketId,
            activeSubjectKey: subjectKey,
          },
        },
      });
      if (existing) return existing;

      return tx.projectGovernanceAssignment.create({
        data: {
          governanceProjectId: bucketId,
          legacyProjectId: input.legacyProjectId ?? null,
          orderId: input.orderId ?? null,
          sourceRecordId: input.sourceRecordId ?? null,
          activeSubjectKey: subjectKey,
          departmentId,
          reasonCode: input.reasonCode,
          status: "OPEN",
          note: input.note ?? null,
          createdById: actor.userId,
        },
      });
    });
  } catch (err) {
    // 并发竞争：另一请求已创建 → 返回已存在的
    if (
      typeof err === "object" && err !== null && "code" in err &&
      (err as { code: string }).code === "P2002"
    ) {
      // 无法在 catch 中可靠拿到 subjectKey；回退按输入 subject 重算后查
      const actorDepartment = await resolveActorDepartmentLive(prisma, actor);
      const { subjectKey } = await resolveSubjectDepartment(
        prisma,
        actor,
        input,
        actorDepartment,
      );
      const raced = await prisma.projectGovernanceAssignment.findUnique({
        where: {
          governanceProjectId_activeSubjectKey: {
            governanceProjectId: bucketId,
            activeSubjectKey: subjectKey,
          },
        },
      });
      if (raced) return raced;
    }
    throw err;
  }
}

/**
 * 解决治理 assignment：绑定真实项目，status=RESOLVED，保留审计。
 * 同事务内校验 assignment / subject / 目标项目 / actor 部门一致。
 */
export async function resolveGovernanceAssignmentForActor(
  actor: BusinessActor,
  assignmentId: string,
  resolvedProjectId: string,
  note?: string | null,
) {
  if (actor.role !== "ADMIN" && actor.role !== "USER") {
    throw new ForbiddenError("仅内部员工可解决治理 assignment");
  }

  return prisma.$transaction(async (tx) => {
    const assignment = await tx.projectGovernanceAssignment.findUnique({
      where: { id: assignmentId },
    });
    if (!assignment) throw new NotFoundError("治理 assignment");
    if (assignment.status !== "OPEN") {
      throw new ValidationError("该 assignment 已处理");
    }

    const actorDepartment = await resolveActorDepartmentLive(tx, actor);

    // 非 ADMIN：assignment 必须属于本部门；历史 departmentId=null 不允许旁路解决
    if (actor.role !== "ADMIN") {
      if (!assignment.departmentId || assignment.departmentId !== actorDepartment) {
        throw new NotFoundError("治理 assignment");
      }
    }

    const project = await tx.project.findUnique({
      where: { id: resolvedProjectId },
      select: { id: true, systemType: true, departmentSnapshot: true, deleted: true },
    });
    if (!project || project.deleted) throw new NotFoundError("真实项目");
    if (project.systemType === GOVERNANCE_PROJECT_SYSTEM_TYPE.GOVERNANCE_BUCKET) {
      throw new ValidationError("不能用治理桶作为真实项目");
    }

    const projectDept = isDepartment(project.departmentSnapshot)
      ? project.departmentSnapshot
      : DEFAULT_DEPARTMENT;
    const assignmentDept = assignment.departmentId
      && isDepartment(assignment.departmentId)
      ? assignment.departmentId
      : null;

    if (actor.role !== "ADMIN") {
      if (projectDept !== actorDepartment) {
        throw new NotFoundError("真实项目");
      }
      if (assignmentDept && projectDept !== assignmentDept) {
        throw new ValidationError("目标项目与治理 assignment 不属于同一部门");
      }
      const readable = await canReadProject(
        project.id,
        actor.userId,
        actor.role,
        tx,
        actorDepartment,
      );
      if (!readable) throw new NotFoundError("真实项目");
    } else if (assignmentDept && projectDept !== assignmentDept) {
      throw new ValidationError("目标项目与治理 assignment 不属于同一部门");
    }

    // 复核 subject 部门 + 当前 object scope（与 create 对称，防权限撤销后仍凭 ID resolve）
    if (assignment.orderId) {
      const order = await tx.order.findUnique({
        where: { id: assignment.orderId },
        select: { id: true, departmentSnapshot: true, deleted: true },
      });
      if (!order || order.deleted) throw new NotFoundError("orderId 对应的订单");
      const orderDept = isDepartment(order.departmentSnapshot)
        ? order.departmentSnapshot
        : DEFAULT_DEPARTMENT;
      if (assignmentDept && orderDept !== assignmentDept) {
        throw new ValidationError("subject 订单部门与 assignment 不一致");
      }
      if (actor.role !== "ADMIN") {
        if (orderDept !== actorDepartment) {
          throw new NotFoundError("orderId 对应的订单");
        }
        const scope = await getOrderScopeWhere(actor.userId, actor.role, tx, actorDepartment);
        if (scope) {
          const visible = await tx.order.findFirst({
            where: { AND: [scope, { id: order.id, deleted: false }] },
            select: { id: true },
          });
          if (!visible) throw new NotFoundError("orderId 对应的订单");
        }
      }
    } else if (assignment.legacyProjectId) {
      const legacy = await tx.project.findUnique({
        where: { id: assignment.legacyProjectId },
        select: { id: true, departmentSnapshot: true },
      });
      if (!legacy) throw new NotFoundError("legacyProjectId 对应的项目");
      const legacyDept = isDepartment(legacy.departmentSnapshot)
        ? legacy.departmentSnapshot
        : DEFAULT_DEPARTMENT;
      if (assignmentDept && legacyDept !== assignmentDept) {
        throw new ValidationError("subject 项目部门与 assignment 不一致");
      }
      if (actor.role !== "ADMIN") {
        if (legacyDept !== actorDepartment) {
          throw new NotFoundError("legacyProjectId 对应的项目");
        }
        const readable = await canReadProject(
          legacy.id,
          actor.userId,
          actor.role,
          tx,
          actorDepartment,
        );
        if (!readable) throw new NotFoundError("legacyProjectId 对应的项目");
      }
    } else if (assignment.sourceRecordId) {
      const sr = await tx.orderSourceRecord.findUnique({
        where: { id: assignment.sourceRecordId },
        select: {
          id: true,
          order: { select: { id: true, departmentSnapshot: true, deleted: true } },
        },
      });
      if (!sr?.order || sr.order.deleted) {
        throw new ValidationError("来源记录未绑定有效订单，无法校验部门");
      }
      const orderDept = isDepartment(sr.order.departmentSnapshot)
        ? sr.order.departmentSnapshot
        : DEFAULT_DEPARTMENT;
      if (assignmentDept && orderDept !== assignmentDept) {
        throw new ValidationError("subject 来源记录部门与 assignment 不一致");
      }
      if (actor.role !== "ADMIN") {
        if (orderDept !== actorDepartment) {
          throw new NotFoundError("sourceRecordId 对应的来源记录");
        }
        const scope = await getOrderScopeWhere(actor.userId, actor.role, tx, actorDepartment);
        if (scope) {
          const visible = await tx.order.findFirst({
            where: { AND: [scope, { id: sr.order.id, deleted: false }] },
            select: { id: true },
          });
          if (!visible) throw new NotFoundError("sourceRecordId 对应的来源记录");
        }
      }
    }

    return tx.projectGovernanceAssignment.update({
      where: { id: assignmentId },
      data: {
        status: "RESOLVED",
        resolvedProjectId,
        note: note ?? assignment.note,
        resolvedAt: new Date(),
        // review #5：进入终态时清空 activeSubjectKey，解除幂等锁，
        // 允许同一 subject 未来重新打开新的 OPEN assignment。
        activeSubjectKey: null,
      },
    });
  });
}
