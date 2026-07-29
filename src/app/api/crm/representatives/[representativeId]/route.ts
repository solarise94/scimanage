import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isRegionalManagerRole } from "@/lib/crm/permissions";
import { REFLOW_THRESHOLD_DAYS } from "@/lib/crm/constants";
import { getRepresentativeCommunicationEvents } from "@/lib/crm/representative-communication-events";
import { getCrmLifecycleSummariesForProfiles, getEffectiveCrmLifecycleStage } from "@/lib/crm/lifecycle";
import {
  getMonthlyCustomerGrowth,
  getMonthlyAverageOrderValue,
  getRepurchaseCategoryConversion,
} from "@/lib/crm/representative-trends";
import {
  buildRepresentativeCollectionMetrics,
  preloadRepresentativeCollectionData,
} from "@/lib/finance/collection-analysis";
import { buildRepresentativePerformanceScope } from "@/lib/crm/representative-performance";
import { loadRepresentativeOpsFacts } from "@/lib/crm/representative-ops-facts";
import { checkinHappenedAt, getRecentScopedCheckinIds } from "@/lib/crm/checkin-event-time";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ representativeId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role === "REPRESENTATIVE") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { representativeId } = await params;
  const rep = await prisma.representative.findUnique({
    where: { id: representativeId },
    include: { regionAssignments: { include: { region: { select: { id: true, name: true } } } } },
  });
  if (!rep) return NextResponse.json({ error: "Representative not found" }, { status: 404 });
  // U5：本部系统代表（kind=SYSTEM）不参与代表运营详情统计。
  if (rep.kind === "SYSTEM") {
    return NextResponse.json({ error: "系统代表不参与运营统计" }, { status: 404 });
  }

  // Regional manager: verify this rep is in their managed set
  if (isRegionalManagerRole(session.user.role)) {
    const manager = await prisma.crmRegionManager.findUnique({
      where: { userId: session.user.id, archived: false },
      include: { reps: { where: { representativeId }, select: { id: true } } },
    });
    if (!manager || manager.reps.length === 0) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // Find linked User
  const linkedUser = await prisma.user.findFirst({
    where: { email: rep.email, role: { in: ["REPRESENTATIVE", "REGIONAL_MANAGER"] } },
    select: { id: true, name: true },
  });

  const userId = linkedUser?.id ?? null;
  const thresholdDate = new Date(Date.now() - REFLOW_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);
  const now = new Date();
  const d30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const d90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const accountUnlinked = !userId;

  // ── Effective representative resolution ───────────────────────────
  // Use the shared performance scope helper. Order / Project / Finance 查询只认 profileIds。
  const scope = await buildRepresentativePerformanceScope(rep.id);
  const {
    profileIds: effectiveProfileIds,
    profileById: scopeProfileById,
  } = scope;

  // Effective anchor map for lifecycle metrics（以 profileId 为键）
  const effectiveAnchorByProfileId = new Map<string, Date | null>();
  for (const [pid, effective] of scope.effectiveByProfileId) {
    effectiveAnchorByProfileId.set(pid, effective.anchorAt);
  }

  // ── Ops facts（与列表/Dashboard 同源）──────────────────────────
  const opsFacts = await loadRepresentativeOpsFacts(
    {
      representativeId: rep.id,
      linkedUserId: userId,
      profileIds: effectiveProfileIds,
    },
    {
      from: d30,
      to: now,
      now,
      longUnvisitedThresholdDate: thresholdDate,
    },
  );

  // 概览只取少量最近事件；大列表走 /customers 与 /follow-ups 子接口
  const recentCheckinIds =
    userId && effectiveProfileIds.length > 0
      ? await getRecentScopedCheckinIds({
          userId,
          profileIds: effectiveProfileIds,
          take: 20,
        })
      : [];
  const [recentCheckinRows, recentCommunicationEvents] = await Promise.all([
    recentCheckinIds.length > 0
      ? prisma.crmVisitCheckin.findMany({
          where: { id: { in: recentCheckinIds } },
          select: {
            id: true,
            profileId: true,
            addressSnapshot: true,
            photoCount: true,
            status: true,
            summaryTitle: true,
            createdAt: true,
            completedAt: true,
            profile: { select: { id: true, name: true } },
          },
        })
      : Promise.resolve([]),
    userId && effectiveProfileIds.length > 0
      ? getRepresentativeCommunicationEvents({
          actorUserIds: [userId],
          profileIds: effectiveProfileIds,
          from: d30,
          to: now,
        })
      : Promise.resolve([]),
  ]);
  const checkinOrder = new Map(recentCheckinIds.map((id, idx) => [id, idx]));
  const recentCheckinSummaries = recentCheckinRows
    .map((c) => ({
      id: c.id,
      profileId: c.profileId,
      profileName: c.profile?.name ?? null,
      addressSnapshot: c.addressSnapshot,
      photoCount: c.photoCount,
      status: c.status,
      summaryTitle: c.summaryTitle,
      happenedAt: checkinHappenedAt(c).toISOString(),
      createdAt: c.createdAt.toISOString(),
      completedAt: c.completedAt?.toISOString() ?? null,
    }))
    .sort((a, b) => (checkinOrder.get(a.id) ?? 0) - (checkinOrder.get(b.id) ?? 0));

  const lifecycleMap = await getCrmLifecycleSummariesForProfiles(effectiveProfileIds);
  const lifecycleValues = [...lifecycleMap.values()];

  // Pre-calculate lifecycle metrics using effective anchor（profileId 分母与 customerCount 对齐）
  let activeCustomerCount = 0;
  let newCustomerCount30d = 0;
  let convertedCustomerCount30d = 0;
  let newCustomerCount90d = 0;
  let convertedCustomerCount90d = 0;
  let orderedCustomerCount30d = 0;
  let repeatCustomerCount30d = 0;
  let orderedCustomerCount90d = 0;
  let repeatCustomerCount90d = 0;
  let dormantCustomerCount = 0;
  let dormantWarningCustomerCount = 0;

  for (const summary of lifecycleValues) {
    if (!summary.profileId) continue;
    const lifecycleStage = getEffectiveCrmLifecycleStage(summary);
    const anchorAt = effectiveAnchorByProfileId.get(summary.profileId)
      ?? summary.assignedAt
      ?? summary.createdAt;

    if (lifecycleStage === "ACTIVE") activeCustomerCount += 1;

    if (anchorAt >= d30) {
      newCustomerCount30d += 1;
      if (summary.firstOrderAt && summary.firstOrderAt >= d30 && summary.firstOrderAt >= anchorAt) {
        convertedCustomerCount30d += 1;
      }
    }

    if (anchorAt >= d90) {
      newCustomerCount90d += 1;
      if (summary.firstOrderAt && summary.firstOrderAt >= d90 && summary.firstOrderAt >= anchorAt) {
        convertedCustomerCount90d += 1;
      }
    }

    if (summary.historicalOrderCount > 0 && summary.lastHistoricalOrderAt && summary.lastHistoricalOrderAt >= d30) {
      orderedCustomerCount30d += 1;
    }
    if (summary.isRepeatCustomer && summary.lastHistoricalOrderAt && summary.lastHistoricalOrderAt >= d30) {
      repeatCustomerCount30d += 1;
    }

    if (summary.historicalOrderCount > 0 && summary.lastHistoricalOrderAt && summary.lastHistoricalOrderAt >= d90) {
      orderedCustomerCount90d += 1;
    }
    if (summary.isRepeatCustomer && summary.lastHistoricalOrderAt && summary.lastHistoricalOrderAt >= d90) {
      repeatCustomerCount90d += 1;
    }

    if (lifecycleStage === "DORMANT") dormantCustomerCount += 1;
    if (summary.dormantRisk && lifecycleStage !== "DORMANT") dormantWarningCustomerCount += 1;
  }

  // ── 月度运营趋势（客户增长 / 复购转化 / 客单价）──────────────
  // 三项均以 profileId 为键（含 Profile-only）；遗留订单仅兼容 profileId IS NULL。
  const anchorByProfileId = new Map<string, Date | null>();
  for (const pid of effectiveProfileIds) {
    anchorByProfileId.set(pid, scope.effectiveByProfileId.get(pid)?.anchorAt ?? null);
  }

  const trendsKey = userId ?? `rep:${rep.id}`;
  const trendsOwnerMap = new Map<string, string[]>([[trendsKey, effectiveProfileIds]]);
  const [growthMap, aovMap, conversionMap] = await Promise.all([
    getMonthlyCustomerGrowth(trendsOwnerMap, anchorByProfileId, 6),
    getMonthlyAverageOrderValue(trendsOwnerMap, 6),
    getRepurchaseCategoryConversion(trendsOwnerMap, 6),
  ]);

  // Backfill conversion detail customer names from Profile view (sovereignty)
  const conversionDetails = (conversionMap.get(trendsKey)?.details ?? []).map((d) => {
    const view = scopeProfileById.get(d.profileId)?.customerView;
    return { ...d, customerName: view?.name ?? d.customerName };
  });

  const trends = {
    customerGrowth: growthMap.get(trendsKey) ?? [],
    averageOrderValue: aovMap.get(trendsKey) ?? [],
    categoryConversion: {
      points: conversionMap.get(trendsKey)?.points ?? [],
      details: conversionDetails,
    },
  };

  const collectionPreload = await preloadRepresentativeCollectionData(effectiveProfileIds);
  const collectionSummary = buildRepresentativeCollectionMetrics(
    effectiveProfileIds,
    collectionPreload.pairs,
    collectionPreload.quarterReceivableMap,
    collectionPreload.yearReceivableMap,
  );

  const relationCount =
    effectiveProfileIds.length > 0
      ? await prisma.customerRelation.count({
          where: {
            OR: [
              { fromProfileId: { in: effectiveProfileIds } },
              { toProfileId: { in: effectiveProfileIds } },
            ],
          },
        })
      : 0;


  // 沟通事件客户名：scope customerView + 缺失回查
  const eventProfileIds = compactUnique(
    recentCommunicationEvents.slice(0, 20).map((e) => e.profileId),
  );
  const eventNameByProfileId = new Map<string, string>();
  for (const [pid, entry] of scopeProfileById) {
    if (entry.customerView?.name) eventNameByProfileId.set(pid, entry.customerView.name);
  }
  const missingEventProfileIds = eventProfileIds.filter((id) => !eventNameByProfileId.has(id));
  if (missingEventProfileIds.length > 0) {
    const extra = await prisma.crmCustomerProfile.findMany({
      where: { id: { in: missingEventProfileIds } },
      select: { id: true, name: true },
    });
    for (const p of extra) {
      if (p.name) eventNameByProfileId.set(p.id, p.name);
    }
  }

  return NextResponse.json({
    representative: { id: rep.id, name: rep.name, email: rep.email, archived: rep.archived },
    linkedUser: linkedUser ?? null,
    accountUnlinked,
    customerCount: opsFacts.customerCount,
    openFollowUpCount: opsFacts.openFollowUps,
    visitCheckinCount: opsFacts.visitCheckinCount,
    lastCheckinAt: opsFacts.lastCheckinAt?.toISOString() ?? null,
    overdueFollowUps: opsFacts.overdueFollowUps,
    longUnvisitedCount: opsFacts.longUnvisitedCount,
    interactionCount30d: opsFacts.interactionCount,
    orphanedOpenFollowUpCount: opsFacts.orphanedOpenFollowUpCount,
    dueCommunicationTaskCount: opsFacts.dueCommunicationTaskCount,
    doneCommunicationTaskCount: opsFacts.doneCommunicationTaskCount,
    overdueCommunicationTaskCount: opsFacts.overdueCommunicationTaskCount,
    communicatedCustomerCount30d: opsFacts.communicatedCustomerCount,
    communicationCoverageRate30d: opsFacts.customerCount > 0 ? opsFacts.communicatedCustomerCount / opsFacts.customerCount : 0,
    activeCustomerCount,
    newCustomerCount30d,
    convertedCustomerCount30d,
    conversionRate30d: newCustomerCount30d > 0 ? convertedCustomerCount30d / newCustomerCount30d : 0,
    newCustomerCount90d,
    convertedCustomerCount90d,
    conversionRate90d: newCustomerCount90d > 0 ? convertedCustomerCount90d / newCustomerCount90d : 0,
    orderedCustomerCount30d,
    repeatCustomerCount30d,
    repeatCustomerRate30d: orderedCustomerCount30d > 0 ? repeatCustomerCount30d / orderedCustomerCount30d : 0,
    orderedCustomerCount90d,
    repeatCustomerCount90d,
    repeatCustomerRate90d: orderedCustomerCount90d > 0 ? repeatCustomerCount90d / orderedCustomerCount90d : 0,
    dormantCustomerCount,
    dormantWarningCustomerCount,
    customers: [],
    recentCheckins: recentCheckinSummaries,
    openFollowUps: [],
    relationCount,
    recentCommunicationEvents: recentCommunicationEvents.slice(0, 20).map((e) => ({
      eventKey: e.eventKey,
      sourceType: e.sourceType,
      sourceId: e.sourceId,
      profileId: e.profileId,
      profileName: eventNameByProfileId.get(e.profileId) ?? null,
      happenedAt: e.happenedAt.toISOString(),
      interactionType: e.interactionType,
      originType: e.originType,
      originId: e.originId,
    })),
    regions: rep.regionAssignments.map((a) => ({
      id: a.region.id,
      name: a.region.name,
      isPrimary: a.isPrimary,
    })),
    trends,
    collectionSummary,
  });
}

function compactUnique(ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}
