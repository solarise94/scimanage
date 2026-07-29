/**
 * 代表运营 KPI 单一事实源（列表 / 详情 / Dashboard 共用）
 *
 * 主权边界：profileId ∈ effectiveProfileIds(rep)
 * 行为指标额外要求 actor/owner == linkedUserId
 * 换绑后 owner 与 profile scope 不一致的任务不计入运营 KPI。
 */

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { CRM_COMMUNICATION_TASK_SOURCE_TYPES } from "@/lib/crm/constants";
import {
  checkinEventTimeInWindowWhere,
  getLastCheckinHappenedAtByProfileIds,
  getLastCheckinHappenedAtByUserAndProfile,
} from "@/lib/crm/checkin-event-time";
import { getRepresentativeCommunicationEvents } from "@/lib/crm/representative-communication-events";
import { collectByChunks } from "@/lib/finance/query-chunk";

type DbClient = typeof prisma | Prisma.TransactionClient;

export type RepresentativeOpsSubject = {
  representativeId: string;
  linkedUserId: string | null;
  profileIds: string[];
};

export type RepresentativeOpsWindows = {
  from: Date;
  to: Date;
  now: Date;
  longUnvisitedThresholdDate: Date;
  periodFrom?: Date | null;
  periodTo?: Date | null;
};

export type RepresentativeOpsFacts = {
  representativeId: string;
  linkedUserId: string | null;
  customerCount: number;
  visitCheckinCount: number;
  lastCheckinAt: Date | null;
  overdueFollowUps: number;
  openFollowUps: number;
  longUnvisitedCount: number;
  interactionCount: number;
  communicatedCustomerCount: number;
  periodVisitCheckinCount: number;
  periodInteractionCount: number;
  dueCommunicationTaskCount: number;
  doneCommunicationTaskCount: number;
  overdueCommunicationTaskCount: number;
  /**
   * owner=linkedUser 但不在 effectiveProfileIds 的开放任务数。
   * 不计入运营 KPI，供治理检查。
   */
  orphanedOpenFollowUpCount: number;
};

function emptyFacts(subject: RepresentativeOpsSubject): RepresentativeOpsFacts {
  return {
    representativeId: subject.representativeId,
    linkedUserId: subject.linkedUserId,
    customerCount: subject.profileIds.length,
    visitCheckinCount: 0,
    lastCheckinAt: null,
    overdueFollowUps: 0,
    openFollowUps: 0,
    longUnvisitedCount: 0,
    interactionCount: 0,
    communicatedCustomerCount: 0,
    periodVisitCheckinCount: 0,
    periodInteractionCount: 0,
    dueCommunicationTaskCount: 0,
    doneCommunicationTaskCount: 0,
    overdueCommunicationTaskCount: 0,
    orphanedOpenFollowUpCount: 0,
  };
}

/**
 * 批量加载运营事实。一次查询后按 profileId → rep / userId → rep 分组。
 */
export async function loadRepresentativeOpsFactsBatch(
  subjects: RepresentativeOpsSubject[],
  windows: RepresentativeOpsWindows,
  db: DbClient = prisma,
): Promise<Map<string, RepresentativeOpsFacts>> {
  const result = new Map<string, RepresentativeOpsFacts>();
  for (const s of subjects) {
    result.set(s.representativeId, emptyFacts(s));
  }
  if (subjects.length === 0) return result;

  const profileToRep = new Map<string, string>();
  const userToRep = new Map<string, string>();
  const allProfileIds: string[] = [];
  const allUserIds: string[] = [];

  for (const s of subjects) {
    for (const pid of s.profileIds) {
      profileToRep.set(pid, s.representativeId);
      allProfileIds.push(pid);
    }
    if (s.linkedUserId) {
      userToRep.set(s.linkedUserId, s.representativeId);
      allUserIds.push(s.linkedUserId);
    }
  }

  const uniqueProfileIds = [...new Set(allProfileIds)];
  const uniqueUserIds = [...new Set(allUserIds)];
  const periodFrom = windows.periodFrom ?? null;
  const periodTo = windows.periodTo ?? null;
  const commSourceTypes = CRM_COMMUNICATION_TASK_SOURCE_TYPES as unknown as string[];

  // 大 IN 列表按 chunk 查询，避免 SQLite P2029 参数上限
  const [
    checkinRows,
    periodCheckinRows,
    openTasks,
    lastCheckinByProfile,
    lastByUserProfile,
    visitInteractions,
    communicationEvents,
    periodCommunicationEvents,
    dueCommTasks,
    doneCommTasks,
    overdueCommTasks,
  ] = await Promise.all([
    uniqueUserIds.length > 0 && uniqueProfileIds.length > 0
      ? collectByChunks(uniqueProfileIds, (chunk) =>
          db.crmVisitCheckin.findMany({
            where: {
              userId: { in: uniqueUserIds },
              profileId: { in: chunk },
              status: "COMPLETED",
              ...checkinEventTimeInWindowWhere(windows.from, windows.to),
            },
            select: { userId: true, profileId: true },
          }),
        )
      : Promise.resolve([] as Array<{ userId: string; profileId: string }>),
    periodFrom && periodTo && uniqueUserIds.length > 0 && uniqueProfileIds.length > 0
      ? collectByChunks(uniqueProfileIds, (chunk) =>
          db.crmVisitCheckin.findMany({
            where: {
              userId: { in: uniqueUserIds },
              profileId: { in: chunk },
              status: "COMPLETED",
              ...checkinEventTimeInWindowWhere(periodFrom, periodTo),
            },
            select: { userId: true, profileId: true },
          }),
        )
      : Promise.resolve([] as Array<{ userId: string; profileId: string }>),
    uniqueUserIds.length > 0
      ? db.crmFollowUpTask.findMany({
          where: {
            ownerUserId: { in: uniqueUserIds },
            status: "OPEN",
          },
          select: { ownerUserId: true, profileId: true, dueAt: true },
        })
      : Promise.resolve(
          [] as Array<{ ownerUserId: string; profileId: string; dueAt: Date }>,
        ),
    getLastCheckinHappenedAtByProfileIds(uniqueProfileIds, db),
    getLastCheckinHappenedAtByUserAndProfile(
      { userIds: uniqueUserIds, profileIds: uniqueProfileIds },
      db,
    ),
    uniqueProfileIds.length > 0
      ? collectByChunks(uniqueProfileIds, (chunk) =>
          db.crmInteraction.findMany({
            where: { profileId: { in: chunk }, type: "VISIT" },
            select: { profileId: true, happenedAt: true },
            orderBy: [{ profileId: "asc" }, { happenedAt: "desc" }],
          }),
        )
      : Promise.resolve([] as Array<{ profileId: string; happenedAt: Date }>),
    uniqueUserIds.length > 0 && uniqueProfileIds.length > 0
      ? collectByChunks(uniqueProfileIds, (chunk) =>
          getRepresentativeCommunicationEvents(
            {
              actorUserIds: uniqueUserIds,
              profileIds: chunk,
              from: windows.from,
              to: windows.to,
            },
            db,
          ),
        )
      : Promise.resolve([]),
    periodFrom && periodTo && uniqueUserIds.length > 0 && uniqueProfileIds.length > 0
      ? collectByChunks(uniqueProfileIds, (chunk) =>
          getRepresentativeCommunicationEvents(
            {
              actorUserIds: uniqueUserIds,
              profileIds: chunk,
              from: periodFrom,
              to: periodTo,
            },
            db,
          ),
        )
      : Promise.resolve([]),
    // 沟通任务：owner + profile 双条件（窗口内 due）
    uniqueUserIds.length > 0 && uniqueProfileIds.length > 0
      ? collectByChunks(uniqueProfileIds, (chunk) =>
          db.crmFollowUpTask.findMany({
            where: {
              ownerUserId: { in: uniqueUserIds },
              profileId: { in: chunk },
              sourceType: { in: commSourceTypes },
              status: { in: ["OPEN", "DONE", "EXPIRED"] },
              dueAt: { gte: windows.from, lt: windows.to },
            },
            select: { ownerUserId: true, profileId: true },
          }),
        )
      : Promise.resolve([] as Array<{ ownerUserId: string; profileId: string }>),
    uniqueUserIds.length > 0 && uniqueProfileIds.length > 0
      ? collectByChunks(uniqueProfileIds, (chunk) =>
          db.crmFollowUpTask.findMany({
            where: {
              ownerUserId: { in: uniqueUserIds },
              profileId: { in: chunk },
              sourceType: { in: commSourceTypes },
              status: "DONE",
              completedAt: { gte: windows.from, lt: windows.to },
            },
            select: { ownerUserId: true, profileId: true },
          }),
        )
      : Promise.resolve([] as Array<{ ownerUserId: string; profileId: string }>),
    uniqueUserIds.length > 0 && uniqueProfileIds.length > 0
      ? collectByChunks(uniqueProfileIds, (chunk) =>
          db.crmFollowUpTask.findMany({
            where: {
              ownerUserId: { in: uniqueUserIds },
              profileId: { in: chunk },
              sourceType: { in: commSourceTypes },
              status: "OPEN",
              dueAt: { lt: windows.now },
            },
            select: { ownerUserId: true, profileId: true },
          }),
        )
      : Promise.resolve([] as Array<{ ownerUserId: string; profileId: string }>),
  ]);

  // 签到 30d / period：actor + profile 同属一个 rep
  for (const row of checkinRows) {
    const repId = userToRep.get(row.userId);
    if (!repId) continue;
    if (profileToRep.get(row.profileId) !== repId) continue;
    const facts = result.get(repId);
    if (!facts) continue;
    facts.visitCheckinCount += 1;
  }
  for (const row of periodCheckinRows) {
    const repId = userToRep.get(row.userId);
    if (!repId) continue;
    if (profileToRep.get(row.profileId) !== repId) continue;
    const facts = result.get(repId);
    if (!facts) continue;
    facts.periodVisitCheckinCount += 1;
  }

  // 最近签到：必须 (user→rep) 与 (profile→rep) 一致后再取最大时间
  for (const row of lastByUserProfile) {
    const repId = userToRep.get(row.userId);
    if (!repId) continue;
    if (profileToRep.get(row.profileId) !== repId) continue;
    const facts = result.get(repId);
    if (!facts) continue;
    if (!facts.lastCheckinAt || row.happenedAt > facts.lastCheckinAt) {
      facts.lastCheckinAt = row.happenedAt;
    }
  }

  // 开放/逾期任务：owner + scope；否则 orphan
  for (const task of openTasks) {
    const repId = userToRep.get(task.ownerUserId);
    if (!repId) continue;
    const facts = result.get(repId);
    if (!facts) continue;
    if (profileToRep.get(task.profileId) !== repId) {
      facts.orphanedOpenFollowUpCount += 1;
      continue;
    }
    facts.openFollowUps += 1;
    if (task.dueAt < windows.now) {
      facts.overdueFollowUps += 1;
    }
  }

  // 沟通任务 KPI：owner + profile 双匹配
  for (const task of dueCommTasks) {
    const repId = userToRep.get(task.ownerUserId);
    if (!repId || profileToRep.get(task.profileId) !== repId) continue;
    const facts = result.get(repId);
    if (facts) facts.dueCommunicationTaskCount += 1;
  }
  for (const task of doneCommTasks) {
    const repId = userToRep.get(task.ownerUserId);
    if (!repId || profileToRep.get(task.profileId) !== repId) continue;
    const facts = result.get(repId);
    if (facts) facts.doneCommunicationTaskCount += 1;
  }
  for (const task of overdueCommTasks) {
    const repId = userToRep.get(task.ownerUserId);
    if (!repId || profileToRep.get(task.profileId) !== repId) continue;
    const facts = result.get(repId);
    if (facts) facts.overdueCommunicationTaskCount += 1;
  }

  // 长期未拜访：scope 内 profile，最后拜访 = max(checkin COALESCE, VISIT interaction)
  const lastVisitIxByProfile = new Map<string, Date>();
  for (const ix of visitInteractions) {
    if (!lastVisitIxByProfile.has(ix.profileId)) {
      lastVisitIxByProfile.set(ix.profileId, ix.happenedAt);
    }
  }
  for (const s of subjects) {
    const facts = result.get(s.representativeId);
    if (!facts) continue;
    let longUnvisited = 0;
    for (const pid of s.profileIds) {
      const lastCheckin = lastCheckinByProfile.get(pid) ?? null;
      const lastIx = lastVisitIxByProfile.get(pid) ?? null;
      let last: Date | null = null;
      if (lastCheckin && lastIx) last = lastCheckin > lastIx ? lastCheckin : lastIx;
      else last = lastCheckin ?? lastIx;
      if (!last || last < windows.longUnvisitedThresholdDate) {
        longUnvisited += 1;
      }
    }
    facts.longUnvisitedCount = longUnvisited;
  }

  // 沟通事件
  const communicatedByRep = new Map<string, Set<string>>();
  for (const event of communicationEvents) {
    const repId = userToRep.get(event.actorUserId);
    if (!repId) continue;
    if (profileToRep.get(event.profileId) !== repId) continue;
    const facts = result.get(repId);
    if (!facts) continue;
    facts.interactionCount += 1;
    const set = communicatedByRep.get(repId) ?? new Set<string>();
    set.add(event.profileId);
    communicatedByRep.set(repId, set);
  }
  for (const [repId, set] of communicatedByRep) {
    const facts = result.get(repId);
    if (facts) facts.communicatedCustomerCount = set.size;
  }
  for (const event of periodCommunicationEvents) {
    const repId = userToRep.get(event.actorUserId);
    if (!repId) continue;
    if (profileToRep.get(event.profileId) !== repId) continue;
    const facts = result.get(repId);
    if (!facts) continue;
    facts.periodInteractionCount += 1;
  }

  return result;
}

export async function loadRepresentativeOpsFacts(
  subject: RepresentativeOpsSubject,
  windows: RepresentativeOpsWindows,
  db: DbClient = prisma,
): Promise<RepresentativeOpsFacts> {
  const map = await loadRepresentativeOpsFactsBatch([subject], windows, db);
  return map.get(subject.representativeId) ?? emptyFacts(subject);
}
