/**
 * 治理 assignment 查询 service。
 *
 * 对应设计文档 §8。治理桶（PRJ-OTHER）的 assignment 列表，
 * 不计入任何正常项目聚合。
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import { ForbiddenError } from "@/lib/application/errors";
import { GOVERNANCE_PROJECT_SYSTEM_TYPE } from "@/lib/products/constants";
import { isDepartment } from "@/lib/department";

const ASSIGNMENT_INCLUDE = {
  governanceProject: { select: { id: true, projectNo: true, name: true } },
  resolvedProject: { select: { id: true, projectNo: true, name: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.ProjectGovernanceAssignmentInclude;

export type GovernanceAssignmentRecord = Prisma.ProjectGovernanceAssignmentGetPayload<{
  include: typeof ASSIGNMENT_INCLUDE;
}>;

function assertCanRead(actor: BusinessActor): void {
  if (actor.role !== "ADMIN" && actor.role !== "USER") {
    throw new ForbiddenError("仅内部员工可查看治理 assignment");
  }
}

export async function listGovernanceAssignmentsForActor(
  actor: BusinessActor,
  filters: { status?: string; reasonCode?: string } = {},
): Promise<GovernanceAssignmentRecord[]> {
  assertCanRead(actor);
  const where: Prisma.ProjectGovernanceAssignmentWhereInput = {};
  if (filters.status) where.status = filters.status;
  if (filters.reasonCode) where.reasonCode = filters.reasonCode;
  // 只查治理桶的 assignment（防误绑普通项目）
  where.governanceProject = { systemType: GOVERNANCE_PROJECT_SYSTEM_TYPE.GOVERNANCE_BUCKET };

  // P1 修复（设计 §6.1）：非 ADMIN 按部门过滤，防止治理桶成为跨部门旁路。
  // 敏感路径从 DB 实时解析，不信任可能陈旧的 actor.department 快照。
  // Fail-closed：用户不存在或 department 非法时返回空集，不静默降级为 FIELD_SALES。
  if (actor.role !== "ADMIN") {
    const user = await prisma.user.findUnique({
      where: { id: actor.userId },
      select: { department: true },
    });
    const department = user && isDepartment(user.department) ? user.department : null;
    if (!department) return [];
    where.departmentId = department;
  }

  return prisma.projectGovernanceAssignment.findMany({
    where,
    include: ASSIGNMENT_INCLUDE,
    orderBy: { createdAt: "desc" },
  });
}
