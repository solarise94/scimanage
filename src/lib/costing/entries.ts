/**
 * CostEntry 校验与 CRUD 辅助。
 *
 * 复用 resolveAndValidateCostRefs（src/lib/finance/costs.ts），
 * 适配 CostEntry 模型（含 bucket/status/sourceType 等）。
 */
import { prisma } from "@/lib/prisma";
import { resolveAndValidateCostRefs } from "@/lib/finance/costs";
import {
  COST_SUBJECT_TYPE,
  COST_SOURCE_TYPE,
  COST_STATUS,
  EFFECTIVE_GROUP_KEY_PREFIX,
  isValidCostBucket,
  isValidCostEntryType,
  isValidCostStatus,
  type CostBucket,
  type CostEntryType,
  type CostStatus,
} from "./constants";
import { recomputeCostSnapshot } from "./recompute";
import { isDepartment } from "@/lib/department";
import { ValidationError } from "@/lib/application/errors";

/** 生成短随机 id（用于手动 sourceKey，避免依赖外部 cuid2 包） */
function randomSourceId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/**
 * 校验 CostEntry 引用的实体一致性（orderId / projectId / profileId）。
 * 委托 resolveAndValidateCostRefs，仅接受活动 CrmCustomerProfile.id。
 */
export async function validateCostEntryRefs(params: {
  profileId?: string | null;
  orderId?: string | null;
  projectId?: string | null;
}): Promise<{
  valid: boolean;
  error?: string;
  resolvedProfileId: string | null;
  resolvedProjectId: string | null;
}> {
  return resolveAndValidateCostRefs(params);
}

/**
 * 创建手动 CostEntry。
 * 自动生成 sourceKey（manual:<cuid>）和 effectiveGroupKey。
 * 创建后重算受影响快照。
 */
export async function createManualCostEntry(params: {
  subjectType: "ORDER" | "PROJECT" | "CUSTOMER" | "MANUAL";
  orderId?: string | null;
  projectId?: string | null;
  profileId?: string | null;
  bucket: CostBucket;
  costType: CostEntryType;
  amount: number; // 分
  status?: CostStatus;
  supplierId?: string | null;
  occurredAt?: Date;
  remark?: string;
  actorUserId: string;
}) {
  const {
    subjectType,
    orderId,
    projectId,
    profileId,
    bucket,
    costType,
    amount,
    status,
    supplierId,
    occurredAt,
    remark,
    actorUserId,
  } = params;

  if (!isValidCostBucket(bucket)) throw new Error(`无效成本桶：${bucket}`);
  if (!isValidCostEntryType(costType)) throw new Error(`无效成本类型：${costType}`);
  if (amount <= 0) throw new Error("金额必须为正数");

  const validation = await validateCostEntryRefs({ profileId, orderId, projectId });
  if (!validation.valid) throw new Error(validation.error);
  if (!validation.resolvedProfileId) {
    throw new Error("必须关联有效的客户档案（profileId）");
  }

  // 部门归属快照解析（设计 §4.2 / §7.2 / §7.3）：
  // 优先从不可变父记录（Order/Project）继承；CUSTOMER/MANUAL 无父时取 actor 部门。
  // 关联 Order/Project 时部门必须一致（§7.3），此处父记录唯一，取父部门即可。
  const resolvedProjectIdFinal = (validation.resolvedProjectId ?? projectId) || null;
  let entryDepartment: string | null = null;
  if (orderId) {
    const ord = await prisma.order.findUnique({
      where: { id: orderId },
      select: { departmentSnapshot: true },
    });
    if (ord) entryDepartment = ord.departmentSnapshot;
  }
  if (!entryDepartment && resolvedProjectIdFinal) {
    const proj = await prisma.project.findUnique({
      where: { id: resolvedProjectIdFinal },
      select: { departmentSnapshot: true },
    });
    if (proj) entryDepartment = proj.departmentSnapshot;
  }
  if (!entryDepartment) {
    // Fail-closed（设计 §6.1 / §7.2）：CUSTOMER/MANUAL 无父记录时取 actor 部门。
    // 用户不存在或 department 非法时拒绝写入，不能静默落 FIELD_SALES 快照。
    const actor = await prisma.user.findUnique({
      where: { id: actorUserId },
      select: { department: true },
    });
    if (!actor || !isDepartment(actor.department)) {
      throw new ValidationError(
        `无法权威解析操作者 ${actorUserId} 的部门，拒绝创建 CostEntry（部门字段缺失或非法）`,
      );
    }
    entryDepartment = actor.department;
  }

  const sourceId = randomSourceId();
  const sourceKey = `manual:${sourceId}`;
  const effectiveGroupKey = `${EFFECTIVE_GROUP_KEY_PREFIX.MANUAL}${sourceId}`;

  const entry = await prisma.costEntry.create({
    data: {
      subjectType,
      orderId: orderId || null,
      projectId: resolvedProjectIdFinal,
      profileId: validation.resolvedProfileId,
      departmentSnapshot: entryDepartment,
      bucket,
      costType,
      status: status ?? "ESTIMATED",
      amount,
      effectiveGroupKey,
      supplierId: supplierId || null,
      sourceType: COST_SOURCE_TYPE.MANUAL,
      sourceKey,
      remark: remark?.trim() || null,
      occurredAt: occurredAt ?? new Date(),
      createdById: actorUserId,
    },
  });

  const recomputeSubjects: { subjectType: "ORDER" | "PROJECT" | "CUSTOMER"; subjectId: string }[] = [];
  if (subjectType === COST_SUBJECT_TYPE.ORDER && orderId) {
    recomputeSubjects.push({ subjectType: "ORDER", subjectId: orderId });
  }
  if (subjectType === COST_SUBJECT_TYPE.PROJECT && (validation.resolvedProjectId || projectId)) {
    recomputeSubjects.push({ subjectType: "PROJECT", subjectId: (validation.resolvedProjectId ?? projectId)! });
  }
  recomputeSubjects.push({ subjectType: "CUSTOMER", subjectId: validation.resolvedProfileId });
  for (const s of recomputeSubjects) {
    await recomputeCostSnapshot(s);
  }

  return entry;
}

/**
 * 更新 CostEntry 金额/状态。
 * 不允许修改 sourceType/sourceKey（幂等键）。
 * 更新后重算快照。
 */
export async function updateCostEntry(params: {
  entryId: string;
  amount?: number;
  status?: CostStatus;
  remark?: string;
  actorUserId: string;
}) {
  const { entryId, amount, status, remark } = params;

  const existing = await prisma.costEntry.findUnique({ where: { id: entryId } });
  if (!existing) throw new Error("NOT_FOUND");

  if (status && !isValidCostStatus(status)) throw new Error(`无效成本状态：${status}`);
  if (amount !== undefined && amount <= 0) throw new Error("金额必须为正数");

  const data: Record<string, unknown> = {};
  if (amount !== undefined) data.amount = amount;
  if (status !== undefined) data.status = status;
  if (remark !== undefined) data.remark = remark?.trim() || null;

  const updated = await prisma.costEntry.update({
    where: { id: entryId },
    data,
  });

  const recomputeSubjects: { subjectType: "ORDER" | "PROJECT" | "CUSTOMER"; subjectId: string }[] = [];
  if (existing.orderId) recomputeSubjects.push({ subjectType: "ORDER", subjectId: existing.orderId });
  if (existing.projectId) recomputeSubjects.push({ subjectType: "PROJECT", subjectId: existing.projectId });
  if (existing.profileId) {
    recomputeSubjects.push({ subjectType: "CUSTOMER", subjectId: existing.profileId });
  }
  for (const s of recomputeSubjects) {
    await recomputeCostSnapshot(s);
  }

  return updated;
}

/**
 * 取消 CostEntry（status → CANCELLED，不物理删除）。
 */
export async function cancelCostEntry(params: {
  entryId: string;
  actorUserId: string;
  reason?: string;
}) {
  const { entryId, reason } = params;
  const existing = await prisma.costEntry.findUnique({ where: { id: entryId } });
  if (!existing) throw new Error("NOT_FOUND");

  const updated = await prisma.costEntry.update({
    where: { id: entryId },
    data: {
      status: COST_STATUS.CANCELLED,
      remark: reason ? `取消：${reason}` : "手动取消",
    },
  });

  const recomputeSubjects: { subjectType: "ORDER" | "PROJECT" | "CUSTOMER"; subjectId: string }[] = [];
  if (existing.orderId) recomputeSubjects.push({ subjectType: "ORDER", subjectId: existing.orderId });
  if (existing.projectId) recomputeSubjects.push({ subjectType: "PROJECT", subjectId: existing.projectId });
  if (existing.profileId) {
    recomputeSubjects.push({ subjectType: "CUSTOMER", subjectId: existing.profileId });
  }
  for (const s of recomputeSubjects) {
    await recomputeCostSnapshot(s);
  }

  return updated;
}
