import { prisma } from "@/lib/prisma";
import { getBusinessDayWindow, getRecentBusinessMonthWindows, getShanghaiParts } from "@/lib/business-time";
import { collectByChunks } from "@/lib/finance/query-chunk";
import { getRepresentativeCommunicationEvents } from "@/lib/crm/representative-communication-events";
import { resolveDashboardScope } from "@/lib/crm/dashboard-data";

export interface CrmMonthlyTrendPoint {
  /** 上海时区自然月，如 "2026-07" */
  month: string;
  /** 展示标签，如 "7月" */
  label: string;
  newCustomers: number;
  interactions: number;
}

/** 最近 6 个自然月（含本月）新增客户与互动次数趋势，按传入 profileIds scope 过滤 */
async function getCrmMonthlyTrend(profileIds: string[], now: Date): Promise<CrmMonthlyTrendPoint[]> {
  const windows = getRecentBusinessMonthWindows(now, 6);
  const buckets = new Map<string, { newCustomers: number; interactions: number }>();
  if (profileIds.length > 0) {
    const trendStart = windows[0].start;
    const [profiles, interactions] = await Promise.all([
      collectByChunks(profileIds, (chunk) =>
        prisma.crmCustomerProfile.findMany({
          where: { id: { in: chunk }, createdAt: { gte: trendStart } },
          select: { createdAt: true },
        }),
      ),
      collectByChunks(profileIds, (chunk) =>
        prisma.crmInteraction.findMany({
          where: { profileId: { in: chunk }, happenedAt: { gte: trendStart } },
          select: { happenedAt: true },
        }),
      ),
    ]);
    for (const profile of profiles) {
      const parts = getShanghaiParts(profile.createdAt);
      const key = `${parts.year}-${String(parts.month).padStart(2, "0")}`;
      const bucket = buckets.get(key) ?? { newCustomers: 0, interactions: 0 };
      bucket.newCustomers += 1;
      buckets.set(key, bucket);
    }
    for (const interaction of interactions) {
      const parts = getShanghaiParts(interaction.happenedAt);
      const key = `${parts.year}-${String(parts.month).padStart(2, "0")}`;
      const bucket = buckets.get(key) ?? { newCustomers: 0, interactions: 0 };
      bucket.interactions += 1;
      buckets.set(key, bucket);
    }
  }
  return windows.map((window) => ({
    month: window.key,
    label: window.label,
    newCustomers: buckets.get(window.key)?.newCustomers ?? 0,
    interactions: buckets.get(window.key)?.interactions ?? 0,
  }));
}

export interface CrmAdminDashboardSummary {
  totalProfiles: number;
  pendingFollowUps: number;
  overdueFollowUps: number;
  communicationCoverageRate30d: number;
  monthlyTrend: CrmMonthlyTrendPoint[];
}

export interface CrmPersonalDashboardSummary {
  myCustomerCount: number;
  overdueTaskCount: number;
  dueTodayTaskCount: number;
  suggestedContactCount: number;
  suggestedVisitCount: number;
  monthlyTrend: CrmMonthlyTrendPoint[];
}

export async function getCrmAdminDashboardSummary(
  userId: string,
  role: string,
  now: Date = new Date(),
): Promise<CrmAdminDashboardSummary> {
  const scope = await resolveDashboardScope(userId, role);
  const profileIds = [...scope.visibleProfileIds];
  if (profileIds.length === 0) {
    return {
      totalProfiles: 0,
      pendingFollowUps: 0,
      overdueFollowUps: 0,
      communicationCoverageRate30d: 0,
      monthlyTrend: await getCrmMonthlyTrend([], now),
    };
  }

  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const [pendingFollowUps, overdueFollowUps, communicationEvents, monthlyTrend] = await Promise.all([
    collectByChunks(profileIds, async (chunk) => [
      await prisma.crmFollowUpTask.count({ where: { status: "OPEN", profileId: { in: chunk } } }),
    ]).then((parts) => parts.reduce((sum, count) => sum + count, 0)),
    collectByChunks(profileIds, async (chunk) => [
      await prisma.crmFollowUpTask.count({
        where: { status: "OPEN", dueAt: { lt: now }, profileId: { in: chunk } },
      }),
    ]).then((parts) => parts.reduce((sum, count) => sum + count, 0)),
    collectByChunks(profileIds, (chunk) =>
      getRepresentativeCommunicationEvents({ from, to: now, profileIds: chunk }),
    ),
    getCrmMonthlyTrend(profileIds, now),
  ]);
  const visibleSet = new Set(profileIds);
  const communicatedCustomerCount = new Set(
    communicationEvents
      .map((event) => event.profileId)
      .filter((id): id is string => Boolean(id) && visibleSet.has(id)),
  ).size;

  return {
    totalProfiles: profileIds.length,
    pendingFollowUps,
    overdueFollowUps,
    communicationCoverageRate30d: communicatedCustomerCount / profileIds.length,
    monthlyTrend,
  };
}

export async function getCrmPersonalDashboardSummary(
  userId: string,
  role: string,
  now: Date = new Date(),
): Promise<CrmPersonalDashboardSummary> {
  const scope = await resolveDashboardScope(userId, role);
  const profileIds = [...scope.myProfileIds];
  if (profileIds.length === 0) {
    return {
      myCustomerCount: 0,
      overdueTaskCount: 0,
      dueTodayTaskCount: 0,
      suggestedContactCount: 0,
      suggestedVisitCount: 0,
      monthlyTrend: await getCrmMonthlyTrend([], now),
    };
  }

  const today = getBusinessDayWindow(now);
  const contactCutoff = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const base = {
    profileId: { in: profileIds },
    ownerUserId: userId,
    status: "OPEN" as const,
  };
  const [overdueTaskCount, dueTodayTaskCount, suggestedContactCount, suggestedVisitCount, monthlyTrend] = await Promise.all([
    prisma.crmFollowUpTask.count({ where: { ...base, dueAt: { lt: now } } }),
    prisma.crmFollowUpTask.count({ where: { ...base, dueAt: { gte: today.start, lt: today.end } } }),
    prisma.crmFollowUpTask.count({
      where: { ...base, dueAt: { gte: now, lte: contactCutoff }, taskType: { not: "VISIT" } },
    }),
    prisma.crmFollowUpTask.count({ where: { ...base, taskType: "VISIT" } }),
    getCrmMonthlyTrend(profileIds, now),
  ]);

  return {
    myCustomerCount: profileIds.length,
    overdueTaskCount,
    dueTodayTaskCount,
    suggestedContactCount,
    suggestedVisitCount,
    monthlyTrend,
  };
}
