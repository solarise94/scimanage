/**
 * CRM 客诉闭环 lib —— 创建/状态流转/任务联动/关闭派生偏好。
 *
 * 设计文档 §客诉闭环模型设计 / §任务联动 / §客诉摘要去重：
 * - 创建客诉：事务内建客诉 + 初始事件 + CrmFollowUpTask(sourceType=CRM_COMPLAINT) + 通知。
 * - 状态流转：每次变更写 STATUS_CHANGED 事件 + 更新主表 status。
 * - 解决客诉：RESOLVED + 事件 + 自动建回访任务。
 * - 关闭客诉：CLOSED + 事件 + 幂等派生 COMPLAINT_SUMMARY 偏好(key=complaint:<id>:summary)。
 * - 重新打开：REOPENED + 事件 + 摘要偏好标 SUPERSEDED。
 *
 * CRM_COMPLAINT 任务不进 CRM_COMMUNICATION_TASK_SOURCE_TYPES，不计入代表沟通 KPI。
 */
import { prisma } from "@/lib/prisma";
import type { CrmComplaint, CrmComplaintEvent } from "@prisma/client";
import {
  COMPLAINT_EVENT_TYPE,
  CRM_COMPLAINT_TASK_SOURCE_TYPE,
  defaultComplaintDueDays,
} from "@/lib/crm/constants";

const COMPLAINT_SELECT = {
  id: true,
  profileId: true,
  title: true,
  description: true,
  category: true,
  severity: true,
  status: true,
  ownerUserId: true,
  sourceType: true,
  sourceId: true,
  relatedOrderId: true,
  relatedProjectId: true,
  relatedInteractionId: true,
  expectedResolutionAt: true,
  resolvedAt: true,
  closedAt: true,
  resolutionSummary: true,
  customerSatisfied: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type CrmComplaintItem = Pick<CrmComplaint, keyof typeof COMPLAINT_SELECT>;

const EVENT_SELECT = {
  id: true,
  complaintId: true,
  eventType: true,
  fromStatus: true,
  toStatus: true,
  content: true,
  createdById: true,
  createdAt: true,
} as const;

export type CrmComplaintEventItem = Pick<CrmComplaintEvent, keyof typeof EVENT_SELECT>;

export { COMPLAINT_SELECT, EVENT_SELECT };

// ── 客诉关联任务的生命周期管理辅助 ──
// 设计文档 §任务联动：客诉状态变化时要维护关联 CrmFollowUpTask，
// 不能让已关闭/取消的客诉在跟进列表中残留 OPEN 任务。

type TxClient = Parameters<Parameters<typeof prisma["$transaction"]>[0]>[0];

/**
 * 重算 profile 的 nextFollowUpAt 缓存。
 * 与标准跟进 API 一致：取该 profile 最早的 OPEN 任务 dueAt。
 * 必须在任务集合变化后调用，否则客户列表/dashboard 会显示过期的下次跟进时间。
 */
async function recalcNextFollowUpAt(tx: TxClient, profileId: string): Promise<void> {
  const earliestOpen = await tx.crmFollowUpTask.findFirst({
    where: { profileId, status: "OPEN" },
    orderBy: { dueAt: "asc" },
    select: { dueAt: true },
  });
  await tx.crmCustomerProfile.update({
    where: { id: profileId },
    data: { nextFollowUpAt: earliestOpen?.dueAt ?? null },
  });
}

/**
 * 关闭/取消某客诉关联的所有未完成 CRM_COMPLAINT 任务。
 * 用于 close / cancel 时收口。CANCELLED 不需要填 completedAt。
 */
async function closeComplaintTasks(
  tx: TxClient,
  complaintId: string,
): Promise<void> {
  await tx.crmFollowUpTask.updateMany({
    where: {
      sourceType: CRM_COMPLAINT_TASK_SOURCE_TYPE,
      sourceId: complaintId,
      status: "OPEN",
    },
    data: { status: "CANCELLED" },
  });
}

/**
 * 重新打开客诉时恢复处理任务。
 * 如果处理任务存在但被取消/完成，恢复为 OPEN 并重置提醒字段；
 * 如果不存在（被删除），重建。
 */
async function reopenComplaintHandleTask(
  tx: TxClient,
  complaintId: string,
  profileId: string,
  ownerUserId: string | null,
  title: string,
  actorUserId: string,
): Promise<void> {
  const handleKey = `complaint-handle:${complaintId}`;
  const existing = await tx.crmFollowUpTask.findUnique({
    where: { sourceOpenKey: handleKey },
    select: { id: true, status: true },
  });
  if (existing) {
    if (existing.status !== "OPEN") {
      // 恢复为 OPEN：清空完成时间、重置提醒状态以便重新提醒
      await tx.crmFollowUpTask.update({
        where: { id: existing.id },
        data: {
          status: "OPEN",
          completedAt: null,
          reminderSent: false,
          reminderStatus: "PENDING",
          reminderSentAt: null,
          reminderLockedAt: null,
          reminderError: null,
        },
      });
    }
  } else {
    // 处理任务已被删除——重建
    await tx.crmFollowUpTask.create({
      data: {
        profileId,
        ownerUserId: ownerUserId ?? actorUserId,
        title: `客诉处理：${title}`,
        dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        status: "OPEN",
        taskType: "OTHER",
        sourceType: CRM_COMPLAINT_TASK_SOURCE_TYPE,
        sourceId: complaintId,
        sourceTitle: title,
        sourceOpenKey: handleKey,
        createdByUserId: actorUserId,
      },
    });
  }
}

/**
 * resolve 时关闭处理任务（处理完毕），然后创建/更新回访任务（幂等 upsert）。
 */
async function resolveComplaintTasks(
  tx: TxClient,
  complaintId: string,
  profileId: string,
  ownerUserId: string | null,
  title: string,
  actorUserId: string,
): Promise<void> {
  // 关闭处理任务——标记 DONE 并填 completedAt
  await tx.crmFollowUpTask.updateMany({
    where: {
      sourceType: CRM_COMPLAINT_TASK_SOURCE_TYPE,
      sourceId: complaintId,
      status: "OPEN",
      sourceOpenKey: `complaint-handle:${complaintId}`,
    },
    data: { status: "DONE", completedAt: new Date() },
  });

  // 回访任务 upsert（reopen → re-resolve 时复用同一条记录）
  const followUpKey = `complaint-followup:${complaintId}`;
  const followUpDue = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const existingFollowUp = await tx.crmFollowUpTask.findUnique({
    where: { sourceOpenKey: followUpKey },
    select: { id: true, status: true },
  });
  if (existingFollowUp) {
    // 恢复回访任务为 OPEN：重置完成时间和提醒字段以便重新提醒
    await tx.crmFollowUpTask.update({
      where: { id: existingFollowUp.id },
      data: {
        status: "OPEN",
        dueAt: followUpDue,
        completedAt: null,
        reminderSent: false,
        reminderStatus: "PENDING",
        reminderSentAt: null,
        reminderLockedAt: null,
        reminderError: null,
      },
    });
  } else {
    await tx.crmFollowUpTask.create({
      data: {
        profileId,
        ownerUserId: ownerUserId ?? actorUserId,
        title: `客诉回访：${title}`,
        dueAt: followUpDue,
        status: "OPEN",
        taskType: "OTHER",
        sourceType: CRM_COMPLAINT_TASK_SOURCE_TYPE,
        sourceId: complaintId,
        sourceTitle: title,
        sourceOpenKey: followUpKey,
        createdByUserId: actorUserId,
      },
    });
  }
}

/**
 * PATCH 客诉时同步当前 OPEN 处理任务。
 *
 * 负责人和截止时间独立同步——只传变化的字段：
 * - ownerUserIdChanged=true 时更新 ownerUserId（null 清空时回退给 actorUserId，
 *   与 createComplaint 一致，避免任务无负责人）。
 * - dueAtChanged=true 时更新 dueAt（只在客诉 expectedResolutionAt 实际变化时传 true，
 *   避免仅改负责人就错误推后截止时间）。
 */
export async function syncComplaintHandleTask(
  tx: TxClient,
  complaintId: string,
  params: {
    ownerUserId: string | null;
    actorUserId: string;
    ownerUserIdChanged: boolean;
    dueAt: Date | null;
    severity: string;
    dueAtChanged: boolean;
  },
): Promise<void> {
  const handleKey = `complaint-handle:${complaintId}`;
  const data: Record<string, unknown> = {};

  if (params.ownerUserIdChanged) {
    // 清空负责人时回退给操作人，与 createComplaint 一致
    data.ownerUserId = params.ownerUserId ?? params.actorUserId;
  }
  if (params.dueAtChanged) {
    data.dueAt = params.dueAt ?? new Date(Date.now() + defaultComplaintDueDays(params.severity) * 24 * 60 * 60 * 1000);
  }

  // 没有字段变化则不更新
  if (Object.keys(data).length === 0) return;

  // 只更新 OPEN 状态的处理任务（DONE/CANCELLED 的不再改）
  await tx.crmFollowUpTask.updateMany({
    where: {
      sourceOpenKey: handleKey,
      status: "OPEN",
    },
    data,
  });
}

/**
 * 创建客诉 + 初始事件 + 处理任务 + 通知。
 * 调用前需已通过 assertCrmProfileAccess 和 validateComplaintRelatedRefs。
 */
export async function createComplaint(params: {
  profileId: string;
  title: string;
  description?: string;
  category: string;
  severity: string;
  ownerUserId?: string;
  sourceType?: string;
  sourceId?: string;
  relatedOrderId?: string | null;
  relatedProjectId?: string | null;
  relatedInteractionId?: string | null;
  expectedResolutionAt?: string | null;
  actorUserId: string;
}): Promise<{ complaint: CrmComplaintItem; taskId: string | null }> {
  const {
    profileId,
    title,
    description,
    category,
    severity,
    ownerUserId,
    sourceType,
    sourceId,
    relatedOrderId,
    relatedProjectId,
    relatedInteractionId,
    expectedResolutionAt,
    actorUserId,
  } = params;

  const expected = expectedResolutionAt ? new Date(expectedResolutionAt) : null;

  return prisma.$transaction(async (tx) => {
    const complaint = await tx.crmComplaint.create({
      data: {
        profileId,
        title,
        description: description ?? null,
        category,
        severity,
        status: "OPEN",
        ownerUserId: ownerUserId ?? null,
        sourceType: sourceType ?? null,
        sourceId: sourceId ?? null,
        relatedOrderId: relatedOrderId ?? null,
        relatedProjectId: relatedProjectId ?? null,
        relatedInteractionId: relatedInteractionId ?? null,
        expectedResolutionAt: expected,
        createdById: actorUserId,
      },
      select: COMPLAINT_SELECT,
    });

    // 初始事件
    await tx.crmComplaintEvent.create({
      data: {
        complaintId: complaint.id,
        eventType: COMPLAINT_EVENT_TYPE[1], // STATUS_CHANGED
        fromStatus: null,
        toStatus: "OPEN",
        content: `客诉已创建：${title}`,
        createdById: actorUserId,
      },
    });

    // 自动生成处理任务（CRM_COMPLAINT，不计入沟通 KPI）
    let taskId: string | null = null;
    const dueAt = expected ?? new Date(Date.now() + defaultComplaintDueDays(severity) * 24 * 60 * 60 * 1000);
    const task = await tx.crmFollowUpTask.create({
      data: {
        profileId,
        ownerUserId: ownerUserId ?? actorUserId,
        title: `客诉处理：${title}`,
        dueAt,
        status: "OPEN",
        taskType: "OTHER",
        sourceType: CRM_COMPLAINT_TASK_SOURCE_TYPE,
        sourceId: complaint.id,
        sourceTitle: title,
        sourceOpenKey: `complaint-handle:${complaint.id}`,
        createdByUserId: actorUserId,
      },
    });
    taskId = task.id;

    // 通知负责人
    if (ownerUserId && ownerUserId !== actorUserId) {
      await tx.notification
        .create({
          data: {
            userId: ownerUserId,
            title: "有新的客诉需要处理",
            content: `客诉「${title}」已分配给您，截止 ${dueAt.toLocaleDateString("zh-CN")}`,
            type: "CRM_COMPLAINT",
            link: `/crm/customers/${profileId}`,
          },
        })
        .catch(() => {});
    }

    // 重算 profile 下一次跟进时间缓存
    await recalcNextFollowUpAt(tx, profileId);

    return { complaint, taskId };
  });
}

/**
 * 添加客诉处理事件 + 可选状态流转。
 */
/**
 * 添加客诉处理事件（纯记录，不改变状态）。
 * 状态变化只能通过 resolveComplaint / closeComplaint / reopenComplaint 进行，
 * 这些受控路径才会维护 resolvedAt/closedAt/摘要偏好/回访任务等副作用。
 */
export async function addComplaintEvent(params: {
  complaintId: string;
  actorUserId: string;
  eventType: string;
  content?: string;
}): Promise<{ complaint: CrmComplaintItem; event: CrmComplaintEventItem }> {
  const { complaintId, actorUserId, eventType, content } = params;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.crmComplaint.findUnique({
      where: { id: complaintId },
      select: { ...COMPLAINT_SELECT },
    });
    if (!existing) throw new Error("NOT_FOUND");

    const event = await tx.crmComplaintEvent.create({
      data: {
        complaintId,
        eventType,
        content: content ?? null,
        createdById: actorUserId,
      },
      select: EVENT_SELECT,
    });

    return { complaint: existing, event };
  });
}

/**
 * 标记客诉为已解决 + 自动生成回访任务。
 */
export async function resolveComplaint(params: {
  complaintId: string;
  actorUserId: string;
  resolutionSummary?: string;
}): Promise<CrmComplaintItem> {
  const { complaintId, actorUserId, resolutionSummary } = params;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.crmComplaint.findUnique({
      where: { id: complaintId },
      select: { ...COMPLAINT_SELECT },
    });
    if (!existing) throw new Error("NOT_FOUND");
    // 仅允许处理态（OPEN/IN_PROGRESS/WAITING_CUSTOMER）进入 RESOLVED。
    // 拒绝已 RESOLVED（避免重复创建回访任务）和已终态（CLOSED/CANCELLED）。
    if (
      existing.status === "RESOLVED" ||
      existing.status === "CLOSED" ||
      existing.status === "CANCELLED"
    ) {
      throw new Error("INVALID_STATUS");
    }

    await tx.crmComplaintEvent.create({
      data: {
        complaintId,
        eventType: COMPLAINT_EVENT_TYPE[5], // RESOLVED
        fromStatus: existing.status,
        toStatus: "RESOLVED",
        content: resolutionSummary ?? null,
        createdById: actorUserId,
      },
    });

    const updated = await tx.crmComplaint.update({
      where: { id: complaintId },
      data: {
        status: "RESOLVED",
        resolvedAt: new Date(),
        resolutionSummary: resolutionSummary ?? existing.resolutionSummary,
      },
      select: COMPLAINT_SELECT,
    });

    // 关闭处理任务 + 创建/更新回访任务（幂等 upsert）
    await resolveComplaintTasks(
      tx,
      complaintId,
      existing.profileId,
      existing.ownerUserId,
      existing.title,
      actorUserId,
    );

    // 重算 profile 下一次跟进时间缓存
    await recalcNextFollowUpAt(tx, existing.profileId);

    return updated;
  });
}

/**
 * 关闭客诉 + 幂等派生 COMPLAINT_SUMMARY 偏好。
 */
export async function closeComplaint(params: {
  complaintId: string;
  actorUserId: string;
  customerSatisfied?: boolean;
}): Promise<{ complaint: CrmComplaintItem; summaryPreferenceId: string }> {
  const { complaintId, actorUserId, customerSatisfied } = params;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.crmComplaint.findUnique({
      where: { id: complaintId },
      select: {
        ...COMPLAINT_SELECT,
        events: { orderBy: { createdAt: "asc" }, select: EVENT_SELECT },
      },
    });
    if (!existing) throw new Error("NOT_FOUND");
    if (existing.status === "CLOSED") {
      throw new Error("ALREADY_CLOSED");
    }
    // 关闭仅允许从 RESOLVED 进入——未经解决的客诉不能直接关闭，
    // 确保状态机完整性（解决→关闭是受控的两步流程）。
    if (existing.status !== "RESOLVED") {
      throw new Error("INVALID_STATUS");
    }

    await tx.crmComplaintEvent.create({
      data: {
        complaintId,
        eventType: COMPLAINT_EVENT_TYPE[7], // CLOSED
        fromStatus: existing.status,
        toStatus: "CLOSED",
        content: customerSatisfied !== undefined ? `客户满意度：${customerSatisfied ? "满意" : "不满意"}` : null,
        createdById: actorUserId,
      },
    });

    const updated = await tx.crmComplaint.update({
      where: { id: complaintId },
      data: {
        status: "CLOSED",
        closedAt: new Date(),
        customerSatisfied: customerSatisfied ?? existing.customerSatisfied,
      },
      select: COMPLAINT_SELECT,
    });

    // 幂等派生 COMPLAINT_SUMMARY 偏好
    const summaryKey = `complaint:${complaintId}:summary`;
    const summaryValueText = `客诉「${existing.title}」已关闭（${existing.category}）。${existing.resolutionSummary ?? ""}`;
    const summaryValueJson = JSON.stringify({
      complaintId,
      category: existing.category,
      severity: existing.severity,
      resolvedAt: existing.resolvedAt?.toISOString() ?? null,
      closedAt: updated.closedAt?.toISOString() ?? null,
      customerSatisfied: customerSatisfied ?? null,
      resolutionSummary: existing.resolutionSummary ?? null,
    });

    const summaryPref = await tx.crmCustomerPreference.upsert({
      where: {
        profileId_sourceType_key: {
          profileId: existing.profileId,
          sourceType: "COMPLAINT",
          key: summaryKey,
        },
      },
      create: {
        profileId: existing.profileId,
        category: "COMPLAINT_SUMMARY",
        key: summaryKey,
        label: `客诉摘要：${existing.title}`,
        valueText: summaryValueText,
        valueJson: summaryValueJson,
        sourceType: "COMPLAINT",
        status: "ACTIVE",
        reviewStatus: "ACCEPTED",
        evidenceType: "COMPLAINT",
        evidenceId: complaintId,
        createdById: actorUserId,
        updatedByUserId: actorUserId,
      },
      update: {
        valueText: summaryValueText,
        valueJson: summaryValueJson,
        status: "ACTIVE",
        updatedByUserId: actorUserId,
      },
      select: { id: true },
    });

    // 关闭所有残留 OPEN 任务（回访任务等），防止已关闭客诉在跟进列表残留
    await closeComplaintTasks(tx, complaintId);

    // 重算 profile 下一次跟进时间缓存
    await recalcNextFollowUpAt(tx, existing.profileId);

    return { complaint: updated, summaryPreferenceId: summaryPref.id };
  });
}

/**
 * 重新打开客诉 + 摘要偏好标 SUPERSEDED。
 */
export async function reopenComplaint(params: {
  complaintId: string;
  actorUserId: string;
  reason?: string;
}): Promise<CrmComplaintItem> {
  const { complaintId, actorUserId, reason } = params;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.crmComplaint.findUnique({
      where: { id: complaintId },
      select: { ...COMPLAINT_SELECT },
    });
    if (!existing) throw new Error("NOT_FOUND");
    if (existing.status !== "CLOSED" && existing.status !== "RESOLVED") {
      throw new Error("INVALID_STATUS");
    }

    await tx.crmComplaintEvent.create({
      data: {
        complaintId,
        eventType: COMPLAINT_EVENT_TYPE[6], // REOPENED
        fromStatus: existing.status,
        toStatus: "IN_PROGRESS",
        content: reason ?? "客诉重新打开",
        createdById: actorUserId,
      },
    });

    const updated = await tx.crmComplaint.update({
      where: { id: complaintId },
      data: {
        status: "IN_PROGRESS",
        closedAt: null,
        resolvedAt: null,
      },
      select: COMPLAINT_SELECT,
    });

    // 摘要偏好标 SUPERSEDED（重新打开后待再次关闭更新回 ACTIVE）
    const summaryKey = `complaint:${complaintId}:summary`;
    await tx.crmCustomerPreference.updateMany({
      where: { profileId: existing.profileId, sourceType: "COMPLAINT", key: summaryKey, status: "ACTIVE" },
      data: { status: "SUPERSEDED", updatedByUserId: actorUserId },
    });

    // 恢复处理任务（可能被 close/cancel 关闭了）
    await reopenComplaintHandleTask(
      tx,
      complaintId,
      existing.profileId,
      existing.ownerUserId,
      existing.title,
      actorUserId,
    );

    // 重算 profile 下一次跟进时间缓存
    await recalcNextFollowUpAt(tx, existing.profileId);

    return updated;
  });
}

/**
 * 取消客诉（误报或取消）+ 取消所有关联任务 + 摘要标 SUPERSEDED。
 * 允许从 OPEN / IN_PROGRESS / WAITING_CUSTOMER 进入 CANCELLED。
 */
export async function cancelComplaint(params: {
  complaintId: string;
  actorUserId: string;
  reason?: string;
}): Promise<CrmComplaintItem> {
  const { complaintId, actorUserId, reason } = params;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.crmComplaint.findUnique({
      where: { id: complaintId },
      select: { ...COMPLAINT_SELECT },
    });
    if (!existing) throw new Error("NOT_FOUND");
    // 仅处理态可取消，已 RESOLVED/CLOSED/CANCELLED 不可取消
    if (
      existing.status === "RESOLVED" ||
      existing.status === "CLOSED" ||
      existing.status === "CANCELLED"
    ) {
      throw new Error("INVALID_STATUS");
    }

    await tx.crmComplaintEvent.create({
      data: {
        complaintId,
        eventType: COMPLAINT_EVENT_TYPE[1], // STATUS_CHANGED
        fromStatus: existing.status,
        toStatus: "CANCELLED",
        content: reason ?? "客诉已取消（误报或作废）",
        createdById: actorUserId,
      },
    });

    const updated = await tx.crmComplaint.update({
      where: { id: complaintId },
      data: {
        status: "CANCELLED",
        closedAt: new Date(),
      },
      select: COMPLAINT_SELECT,
    });

    // 取消所有关联 OPEN 任务
    await closeComplaintTasks(tx, complaintId);

    // 重算 profile 下一次跟进时间缓存
    await recalcNextFollowUpAt(tx, existing.profileId);

    return updated;
  });
}
