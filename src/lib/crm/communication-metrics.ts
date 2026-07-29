import { prisma } from "@/lib/prisma";
import { CRM_COMMUNICATION_TASK_SOURCE_TYPES } from "@/lib/crm/constants";
import { getRepresentativeCommunicationEvents } from "@/lib/crm/representative-communication-events";
import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * 本模块保留为“沟通任务 + 覆盖率”的聚合外观：due/done/overdue 来自 CrmFollowUpTask，
 * 沟通事实一律委托 representative-communication-events.ts。这里不再直接定义 interaction
 * 类型白名单，也不再按 Profile 当前 owner 倒推历史行为人。
 */

type DbClient = PrismaClient | Prisma.TransactionClient;

export type CrmCommunicationMetrics = {
  assignedCustomerCount: number;
  dueCommunicationTaskCount: number;
  doneCommunicationTaskCount: number;
  overdueCommunicationTaskCount: number;
  communicatedCustomerCount: number;
  communicationCoverageRate: number;
};

function emptyCrmCommunicationMetrics(): CrmCommunicationMetrics {
  return {
    assignedCustomerCount: 0,
    dueCommunicationTaskCount: 0,
    doneCommunicationTaskCount: 0,
    overdueCommunicationTaskCount: 0,
    communicatedCustomerCount: 0,
    communicationCoverageRate: 0,
  };
}

export async function getCrmCommunicationMetrics(
  params: {
    ownerUserIds?: string[];
    actorUserIds?: string[];
    profileIds?: string[];
    from: Date;
    to: Date;
    /** Optional frozen clock for overdue / coverage (W5.4 KPI). Defaults to now. */
    now?: Date;
  },
  db: DbClient = prisma,
): Promise<CrmCommunicationMetrics> {
  const ownerUserIds = params.ownerUserIds?.filter(Boolean) ?? [];
  const profileIds = params.profileIds?.filter(Boolean) ?? [];

  const profileWhere: Prisma.CrmCustomerProfileWhereInput = {};
  if (ownerUserIds.length > 0) profileWhere.ownerUserId = { in: ownerUserIds };
  if (profileIds.length > 0) profileWhere.id = { in: profileIds };
  profileWhere.archived = false;
  profileWhere.assignmentStatus = "ASSIGNED";

  const profiles = await db.crmCustomerProfile.findMany({
    where: profileWhere,
    select: { id: true },
  });
  const scopedProfileIds = profiles.map((profile) => profile.id);
  if (scopedProfileIds.length === 0) {
    return emptyCrmCommunicationMetrics();
  }

  const now = params.now ?? new Date();
  const [dueCommunicationTaskCount, doneCommunicationTaskCount, overdueCommunicationTaskCount, communicationEvents] = await Promise.all([
    db.crmFollowUpTask.count({
      where: {
        profileId: { in: scopedProfileIds },
        sourceType: { in: CRM_COMMUNICATION_TASK_SOURCE_TYPES as unknown as string[] },
        status: { in: ["OPEN", "DONE", "EXPIRED"] },
        dueAt: { gte: params.from, lt: params.to },
      },
    }),
    db.crmFollowUpTask.count({
      where: {
        profileId: { in: scopedProfileIds },
        sourceType: { in: CRM_COMMUNICATION_TASK_SOURCE_TYPES as unknown as string[] },
        status: "DONE",
        completedAt: { gte: params.from, lt: params.to },
      },
    }),
    db.crmFollowUpTask.count({
      where: {
        profileId: { in: scopedProfileIds },
        sourceType: { in: CRM_COMMUNICATION_TASK_SOURCE_TYPES as unknown as string[] },
        status: "OPEN",
        dueAt: { lt: now },
      },
    }),
    getRepresentativeCommunicationEvents({
      actorUserIds: params.actorUserIds ?? ownerUserIds,
      profileIds: scopedProfileIds,
      from: params.from,
      to: params.to,
    }, db),
  ]);

  const communicatedCustomerCount = new Set(
    communicationEvents.map((event) => event.profileId).filter(Boolean),
  ).size;
  return {
    assignedCustomerCount: scopedProfileIds.length,
    dueCommunicationTaskCount,
    doneCommunicationTaskCount,
    overdueCommunicationTaskCount,
    communicatedCustomerCount,
    communicationCoverageRate: scopedProfileIds.length > 0
      ? communicatedCustomerCount / scopedProfileIds.length
      : 0,
  };
}

export async function getCrmCommunicationMetricsByOwnerUserIds(
  params: {
    ownerUserIds: string[];
    from: Date;
    to: Date;
  },
  db: DbClient = prisma,
): Promise<Map<string, CrmCommunicationMetrics>> {
  const ownerUserIds = [...new Set(params.ownerUserIds.filter(Boolean))];
  const result = new Map<string, CrmCommunicationMetrics>(
    ownerUserIds.map((ownerUserId) => [ownerUserId, emptyCrmCommunicationMetrics()]),
  );
  if (ownerUserIds.length === 0) return result;

  const profiles = await db.crmCustomerProfile.findMany({
    where: {
      ownerUserId: { in: ownerUserIds },
      archived: false,
      assignmentStatus: "ASSIGNED",
    },
    select: { id: true, ownerUserId: true },
  });
  if (profiles.length === 0) return result;

  const profileIds = profiles.map((profile) => profile.id);
  const profileOwnerMap = new Map(profiles.map((profile) => [profile.id, profile.ownerUserId]));
  const now = new Date();

  for (const profile of profiles) {
    if (!profile.ownerUserId) continue;
    const current = result.get(profile.ownerUserId) ?? emptyCrmCommunicationMetrics();
    current.assignedCustomerCount += 1;
    result.set(profile.ownerUserId, current);
  }

  const [dueCounts, doneCounts, overdueCounts, communicationEvents] = await Promise.all([
    db.crmFollowUpTask.groupBy({
      by: ["profileId"],
      where: {
        profileId: { in: profileIds },
        sourceType: { in: CRM_COMMUNICATION_TASK_SOURCE_TYPES as unknown as string[] },
        status: { in: ["OPEN", "DONE", "EXPIRED"] },
        dueAt: { gte: params.from, lt: params.to },
      },
      _count: true,
    }),
    db.crmFollowUpTask.groupBy({
      by: ["profileId"],
      where: {
        profileId: { in: profileIds },
        sourceType: { in: CRM_COMMUNICATION_TASK_SOURCE_TYPES as unknown as string[] },
        status: "DONE",
        completedAt: { gte: params.from, lt: params.to },
      },
      _count: true,
    }),
    db.crmFollowUpTask.groupBy({
      by: ["profileId"],
      where: {
        profileId: { in: profileIds },
        sourceType: { in: CRM_COMMUNICATION_TASK_SOURCE_TYPES as unknown as string[] },
        status: "OPEN",
        dueAt: { lt: now },
      },
      _count: true,
    }),
    getRepresentativeCommunicationEvents({
      actorUserIds: ownerUserIds,
      profileIds,
      from: params.from,
      to: params.to,
    }, db),
  ]);

  for (const row of dueCounts) {
    const ownerUserId = profileOwnerMap.get(row.profileId);
    if (!ownerUserId) continue;
    const current = result.get(ownerUserId) ?? emptyCrmCommunicationMetrics();
    current.dueCommunicationTaskCount += row._count;
    result.set(ownerUserId, current);
  }
  for (const row of doneCounts) {
    const ownerUserId = profileOwnerMap.get(row.profileId);
    if (!ownerUserId) continue;
    const current = result.get(ownerUserId) ?? emptyCrmCommunicationMetrics();
    current.doneCommunicationTaskCount += row._count;
    result.set(ownerUserId, current);
  }
  for (const row of overdueCounts) {
    const ownerUserId = profileOwnerMap.get(row.profileId);
    if (!ownerUserId) continue;
    const current = result.get(ownerUserId) ?? emptyCrmCommunicationMetrics();
    current.overdueCommunicationTaskCount += row._count;
    result.set(ownerUserId, current);
  }
  const communicatedByActor = new Map<string, Set<string>>();
  for (const event of communicationEvents) {
    if (!event.profileId) continue;
    const profileIdsForActor = communicatedByActor.get(event.actorUserId) ?? new Set<string>();
    profileIdsForActor.add(event.profileId);
    communicatedByActor.set(event.actorUserId, profileIdsForActor);
  }
  for (const [ownerUserId, profileIdsForActor] of communicatedByActor) {
    const current = result.get(ownerUserId) ?? emptyCrmCommunicationMetrics();
    current.communicatedCustomerCount = profileIdsForActor.size;
    result.set(ownerUserId, current);
  }

  for (const [ownerUserId, metrics] of result) {
    metrics.communicationCoverageRate = metrics.assignedCustomerCount > 0
      ? metrics.communicatedCustomerCount / metrics.assignedCustomerCount
      : 0;
    result.set(ownerUserId, metrics);
  }

  return result;
}

/**
 * Get communication metrics grouped by an arbitrary key derived from profile ownership.
 * The caller provides a map of profileId -> groupKey (e.g. effective ownerUserId).
 * Returns metrics per groupKey.
 */
export async function getCrmCommunicationMetricsByProfileIds(
  params: {
    profileIds: string[];
    from: Date;
    to: Date;
    /** Optional frozen clock for overdue (W5.4 KPI). Defaults to now. */
    now?: Date;
  },
  db: DbClient = prisma,
): Promise<Map<string, CrmCommunicationMetrics>> {
  const profileIds = [...new Set(params.profileIds.filter(Boolean))];
  const result = new Map<string, CrmCommunicationMetrics>();
  if (profileIds.length === 0) return result;

  const now = params.now ?? new Date();
  const [dueCounts, doneCounts, overdueCounts, communicationEvents] = await Promise.all([
    db.crmFollowUpTask.groupBy({
      by: ["profileId"],
      where: {
        profileId: { in: profileIds },
        sourceType: { in: CRM_COMMUNICATION_TASK_SOURCE_TYPES as unknown as string[] },
        status: { in: ["OPEN", "DONE", "EXPIRED"] },
        dueAt: { gte: params.from, lt: params.to },
      },
      _count: true,
    }),
    db.crmFollowUpTask.groupBy({
      by: ["profileId"],
      where: {
        profileId: { in: profileIds },
        sourceType: { in: CRM_COMMUNICATION_TASK_SOURCE_TYPES as unknown as string[] },
        status: "DONE",
        completedAt: { gte: params.from, lt: params.to },
      },
      _count: true,
    }),
    db.crmFollowUpTask.groupBy({
      by: ["profileId"],
      where: {
        profileId: { in: profileIds },
        sourceType: { in: CRM_COMMUNICATION_TASK_SOURCE_TYPES as unknown as string[] },
        status: "OPEN",
        dueAt: { lt: now },
      },
      _count: true,
    }),
    getRepresentativeCommunicationEvents({
      profileIds,
      from: params.from,
      to: params.to,
    }, db),
  ]);

  // Return per-profileId metrics. Caller is responsible for grouping by ownerUserId.
  for (const profileId of profileIds) {
    result.set(profileId, emptyCrmCommunicationMetrics());
  }

  for (const row of dueCounts) {
    const current = result.get(row.profileId) ?? emptyCrmCommunicationMetrics();
    current.dueCommunicationTaskCount += row._count;
    result.set(row.profileId, current);
  }
  for (const row of doneCounts) {
    const current = result.get(row.profileId) ?? emptyCrmCommunicationMetrics();
    current.doneCommunicationTaskCount += row._count;
    result.set(row.profileId, current);
  }
  for (const row of overdueCounts) {
    const current = result.get(row.profileId) ?? emptyCrmCommunicationMetrics();
    current.overdueCommunicationTaskCount += row._count;
    result.set(row.profileId, current);
  }
  for (const profileId of new Set(communicationEvents.map((event) => event.profileId))) {
    const current = result.get(profileId) ?? emptyCrmCommunicationMetrics();
    current.communicatedCustomerCount += 1;
    result.set(profileId, current);
  }

  for (const [profileId, metrics] of result) {
    metrics.communicationCoverageRate = metrics.assignedCustomerCount > 0
      ? metrics.communicatedCustomerCount / metrics.assignedCustomerCount
      : 0;
    result.set(profileId, metrics);
  }

  return result;
}
