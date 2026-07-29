import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { isRegionalManagerRole } from "@/lib/crm/permissions";
import { REFLOW_THRESHOLD_DAYS } from "@/lib/crm/constants";
import { getCrmLifecycleSummariesForProfiles, getEffectiveCrmLifecycleStage } from "@/lib/crm/lifecycle";
import {
  getMonthlyCustomerGrowth,
  getMonthlyAverageOrderValue,
  getRepurchaseCategoryConversion,
} from "@/lib/crm/representative-trends";
import {
  buildRepresentativeCollectionMetrics,
  preloadRepresentativeCollectionData,
  type CollectionSummaryMetrics,
} from "@/lib/finance/collection-analysis";
import { groupPerformanceScopesByEffectiveOwner } from "@/lib/crm/representative-performance";
import { getBusinessRecognitionEvents } from "@/lib/finance/business-recognition";
import { loadRepresentativeOpsFactsBatch } from "@/lib/crm/representative-ops-facts";
import {
  getBusinessDayWindow,
  getBusinessWeekWindow,
} from "@/lib/business-time";
import { collectByChunks } from "@/lib/finance/query-chunk";

const EMPTY_COLLECTION_METRICS: CollectionSummaryMetrics = {
  avgCollectionCycleDays: null,
  collectionPairCount: 0,
  excludedNegativeCycleCount: 0,
  usedFallbackCount: 0,
  quarterlyReceiptRate: null,
  quarterlyReceiptAmount: 0,
  quarterlyReceivableAmount: 0,
  quarterlyBelowThreshold: true,
  yearlyReceiptRate: null,
  yearlyReceiptAmount: 0,
  yearlyReceivableAmount: 0,
  yearlyBelowThreshold: true,
};

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role === "REPRESENTATIVE") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = req.nextUrl;
  const search = searchParams.get("search") || "";
  const representativeIdsParam = searchParams.get("representativeIds") || "";
  const regionId = searchParams.get("regionId") || "";
  const archived = searchParams.get("archived") || "active";
  const hasUserParam = searchParams.get("hasUser") || "";
  const hasOverdueParam = searchParams.get("hasOverdue") || "";
  const hasLongUnvisitedParam = searchParams.get("hasLongUnvisited") || "";
  const sort = searchParams.get("sort") || "name";
  const order = searchParams.get("order") || "asc";
  const period = searchParams.get("period") || ""; // "today" | "week" | ""
  const lite = searchParams.get("lite") === "1" || searchParams.get("lite") === "true";

  // Determine which representatives to query
  let repEmailFilter: string[] | undefined;
  if (isRegionalManagerRole(session.user.role)) {
    const manager = await prisma.crmRegionManager.findUnique({
      where: { userId: session.user.id, archived: false },
      include: { reps: { select: { representative: { select: { email: true } } } } },
    });
    if (!manager || manager.reps.length === 0) {
      return NextResponse.json({ representatives: [] });
    }
    repEmailFilter = manager.reps.map((r) => r.representative.email);
  }

  // Build where clause
  // U5：代表运营指标/排行榜排除本部系统代表（kind=SYSTEM），只统计真人代表。
  const where: Prisma.RepresentativeWhereInput = { kind: "HUMAN" };
  if (repEmailFilter) where.email = { in: repEmailFilter };
  if (search) {
    where.OR = [
      { name: { contains: search } },
      { email: { contains: search } },
    ];
  }

  // Filter by specific representative IDs
  if (representativeIdsParam) {
    const ids = representativeIdsParam.split(",").filter(Boolean);
    // Scope enforcement for REGIONAL_MANAGER
    if (isRegionalManagerRole(session.user.role) && repEmailFilter) {
      const allowedReps = await prisma.representative.findMany({
        where: { id: { in: ids }, email: { in: repEmailFilter } },
        select: { id: true },
      });
      where.id = { in: allowedReps.map((r) => r.id) };
    } else {
      where.id = { in: ids };
    }
  }

  // Archived filter
  if (archived === "active") where.archived = false;
  else if (archived === "archived") where.archived = true;

  // lite=1：只返回选择器用的轻量字段，跳过全库 KPI 聚合
  if (lite) {
    if (regionId) {
      where.regionAssignments = { some: { regionId } };
    }
    const liteReps = await prisma.representative.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        archived: true,
      },
      orderBy: { name: "asc" },
    });
    return NextResponse.json({
      representatives: liteReps.map((r) => ({
        representativeId: r.id,
        name: r.name,
        email: r.email,
        archived: r.archived,
      })),
    });
  }

  // Region filter
  if (regionId) {
    where.regionAssignments = { some: { regionId } };
  }

  const reps = await prisma.representative.findMany({
    where,
    select: {
      id: true, name: true, email: true, archived: true,
      regionAssignments: {
        select: { id: true, isPrimary: true, region: { select: { id: true, name: true } } },
      },
    },
    orderBy: { name: "asc" },
  });

  // linked User 只认销售角色，与详情/ops-facts 的 accountUnlinked 口径一致
  const repEmails = reps.map((r) => r.email);
  const repUsers = await prisma.user.findMany({
    where: {
      email: { in: repEmails },
      role: { in: ["REPRESENTATIVE", "REGIONAL_MANAGER"] },
    },
    select: { id: true, email: true, name: true, role: true },
  });
  const emailToUser = new Map(repUsers.map((u) => [u.email, u]));

  // ── Effective representative resolution ───────────────────────────
  // Use the shared performance scope helper. Groups keyed by representativeId；
  // 指标 join 只认 profileIds（含 Profile-only）。
  const repScopeGroups = await groupPerformanceScopesByEffectiveOwner();

  const repEffectiveProfileIds = new Map<string, string[]>();
  const repCustomerCountMap = new Map<string, number>();
  for (const [representativeId, group] of repScopeGroups) {
    repEffectiveProfileIds.set(representativeId, group.profileIds);
    repCustomerCountMap.set(representativeId, group.profileIds.length);
  }

  const allEffectiveProfileIds = [...new Set(
    Array.from(repEffectiveProfileIds.values()).flat(),
  )];
  const profileEffectiveRepMap = new Map<string, string>();
  for (const [representativeId, group] of repScopeGroups) {
    for (const profileId of group.profileIds) {
      profileEffectiveRepMap.set(profileId, representativeId);
    }
  }

  // ── Windows ─────────────────────────────────────────────────────
  const now = new Date();
  const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const d90 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const thresholdDate = new Date(now.getTime() - REFLOW_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);

  let periodStart: Date | null = null;
  let periodEnd: Date | null = null;
  if (period === "today") {
    const w = getBusinessDayWindow(now);
    periodStart = w.start;
    periodEnd = w.end;
  } else if (period === "week") {
    const w = getBusinessWeekWindow(now);
    periodStart = w.start;
    periodEnd = w.end;
  }

  // ── Ops facts（签到/沟通/逾期/长期未访 单一事实源）────────────
  const opsSubjects = reps.map((rep) => {
    const linkedUser = emailToUser.get(rep.email);
    const linkedUserId =
      linkedUser && (linkedUser.role === "REPRESENTATIVE" || linkedUser.role === "REGIONAL_MANAGER")
        ? linkedUser.id
        : null;
    return {
      representativeId: rep.id,
      linkedUserId,
      profileIds: repEffectiveProfileIds.get(rep.id) ?? [],
    };
  });
  const opsFactsByRep = await loadRepresentativeOpsFactsBatch(opsSubjects, {
    from: d30,
    to: now,
    now,
    longUnvisitedThresholdDate: thresholdDate,
    periodFrom: periodStart,
    periodTo: periodEnd,
  });

  // ── Batch queries（订单/生命周期/沟通任务）────────────────────
  const [
    periodOrders,
    lifecycleMap,
  ] = await Promise.all([
    periodStart && periodEnd && allEffectiveProfileIds.length > 0
      ? collectByChunks(allEffectiveProfileIds, (chunk) =>
          prisma.order.findMany({
            where: {
              profileId: { in: chunk },
              OR: [
                { orderedAt: { gte: periodStart, lt: periodEnd } },
                { orderedAt: null, confirmedAt: { gte: periodStart, lt: periodEnd } },
                { orderedAt: null, confirmedAt: null, createdAt: { gte: periodStart, lt: periodEnd } },
              ],
              deleted: false,
              archived: false,
              status: { in: ["CONFIRMED", "DELIVERED", "CLOSED"] },
            },
            select: { id: true, profileId: true, status: true, totalAmount: true, financeAmountOverride: true },
          }),
        )
      : Promise.resolve([]),
    getCrmLifecycleSummariesForProfiles(allEffectiveProfileIds),
  ]);

  // Recognition events for period business amounts（以 profileId 归属代表）
  const recognitionEvents = periodStart && periodEnd && allEffectiveProfileIds.length > 0
    ? await getBusinessRecognitionEvents({
        profileIds: allEffectiveProfileIds,
        periodStart,
        periodEnd,
      })
    : [];

  const recognitionByRepId = new Map<string, {
    newBusinessCents: number;
    deliveryBusinessCents: number;
    confirmedBusinessCents: number;
  }>();
  for (const event of recognitionEvents) {
    const repId = profileEffectiveRepMap.get(event.profileId);
    if (!repId) continue;
    const current = recognitionByRepId.get(repId) ?? {
      newBusinessCents: 0,
      deliveryBusinessCents: 0,
      confirmedBusinessCents: 0,
    };
    if (event.phase === "PRODUCT_100" || event.phase === "SERVICE_START_30") {
      current.newBusinessCents += event.amountCents;
    }
    if (event.phase === "SERVICE_DELIVERY_70") {
      current.deliveryBusinessCents += event.amountCents;
    }
    current.confirmedBusinessCents += event.amountCents;
    recognitionByRepId.set(repId, current);
  }

  // Period orders grouped by effective representative
  // 订单事实口径：count + 全额（financeAmountOverride ?? totalAmount ?? 0）。
  // 与 recognition 确认额分开：这里回答"接了多少单、签了多少额"，
  // recognition 回答"按 30/70 确认了多少业务额"。
  const repPeriodOrderCountMap = new Map<string, number>();
  const repPeriodOrderAmountMap = new Map<string, number>();

  for (const order of periodOrders) {
    if (!order.profileId) continue;
    const repId = profileEffectiveRepMap.get(order.profileId);
    if (!repId) continue;
    repPeriodOrderCountMap.set(
      repId,
      (repPeriodOrderCountMap.get(repId) || 0) + 1,
    );
    const orderAmount = order.financeAmountOverride ?? order.totalAmount ?? 0;
    repPeriodOrderAmountMap.set(
      repId,
      (repPeriodOrderAmountMap.get(repId) || 0) + orderAmount,
    );
  }

  // Period new customers (by effective anchor，含 Profile-only)
  const repPeriodNewCustomerCountMap = new Map<string, number>();
  if (periodStart && periodEnd) {
    for (const group of repScopeGroups.values()) {
      for (const profileId of group.profileIds) {
        const effective = group.effectiveByProfileId.get(profileId);
        if (!effective?.anchorAt) continue;
        if (effective.anchorAt >= periodStart && effective.anchorAt < periodEnd) {
          repPeriodNewCustomerCountMap.set(
            group.representativeId,
            (repPeriodNewCustomerCountMap.get(group.representativeId) || 0) + 1,
          );
        }
      }
    }
  }

  // Lifecycle stats grouped by effective representative (using effective anchor)
  const repLifecycleStats = new Map<string, {
    orderedCustomerCount30d: number;
    repeatCustomerCount30d: number;
    orderedCustomerCount90d: number;
    repeatCustomerCount90d: number;
    activeCustomerCount: number;
    newCustomerCount30d: number;
    convertedCustomerCount30d: number;
    newCustomerCount90d: number;
    convertedCustomerCount90d: number;
    dormantCustomerCount: number;
    dormantWarningCustomerCount: number;
  }>();

  for (const summary of lifecycleMap.values()) {
    const repId = profileEffectiveRepMap.get(summary.profileId);
    if (!repId) continue;
    const group = repScopeGroups.get(repId);
    const effective = group?.effectiveByProfileId.get(summary.profileId);
    if (!effective) continue;

    const current = repLifecycleStats.get(repId) ?? {
      orderedCustomerCount30d: 0,
      repeatCustomerCount30d: 0,
      orderedCustomerCount90d: 0,
      repeatCustomerCount90d: 0,
      activeCustomerCount: 0,
      newCustomerCount30d: 0,
      convertedCustomerCount30d: 0,
      newCustomerCount90d: 0,
      convertedCustomerCount90d: 0,
      dormantCustomerCount: 0,
      dormantWarningCustomerCount: 0,
    };

    const anchorAt = effective.anchorAt;
    const lifecycleStage = getEffectiveCrmLifecycleStage(summary);

    if (lifecycleStage === "ACTIVE") {
      current.activeCustomerCount += 1;
    }

    if (anchorAt && anchorAt >= d30) {
      current.newCustomerCount30d += 1;
      if (
        summary.firstOrderAt &&
        summary.firstOrderAt >= d30 &&
        summary.firstOrderAt >= anchorAt
      ) {
        current.convertedCustomerCount30d += 1;
      }
    }

    if (anchorAt && anchorAt >= d90) {
      current.newCustomerCount90d += 1;
      if (
        summary.firstOrderAt &&
        summary.firstOrderAt >= d90 &&
        summary.firstOrderAt >= anchorAt
      ) {
        current.convertedCustomerCount90d += 1;
      }
    }

    if (summary.historicalOrderCount > 0 && summary.lastHistoricalOrderAt && summary.lastHistoricalOrderAt >= d30) {
      current.orderedCustomerCount30d += 1;
    }
    if (summary.isRepeatCustomer && summary.lastHistoricalOrderAt && summary.lastHistoricalOrderAt >= d30) {
      current.repeatCustomerCount30d += 1;
    }

    if (summary.historicalOrderCount > 0 && summary.lastHistoricalOrderAt && summary.lastHistoricalOrderAt >= d90) {
      current.orderedCustomerCount90d += 1;
    }
    if (summary.isRepeatCustomer && summary.lastHistoricalOrderAt && summary.lastHistoricalOrderAt >= d90) {
      current.repeatCustomerCount90d += 1;
    }

    if (lifecycleStage === "DORMANT") current.dormantCustomerCount += 1;
    if (summary.dormantRisk && lifecycleStage !== "DORMANT") current.dormantWarningCustomerCount += 1;
    repLifecycleStats.set(repId, current);
  }

  // ── 月度运营趋势（当月快照，供列表汇总列）────────────────────
  // 有效归属锚点（profileId → effective anchorAt），含 Profile-only。
  const anchorByProfileId = new Map<string, Date | null>();
  for (const group of repScopeGroups.values()) {
    for (const [pid, eff] of group.effectiveByProfileId) {
      anchorByProfileId.set(pid, eff.anchorAt);
    }
  }

  const currentMonthTrendsRepIds = [...repEffectiveProfileIds.keys()];
  const repTrendMaps = currentMonthTrendsRepIds.length > 0
    ? await Promise.all([
        getMonthlyCustomerGrowth(repEffectiveProfileIds, anchorByProfileId, 1),
        getMonthlyAverageOrderValue(repEffectiveProfileIds, 1),
        getRepurchaseCategoryConversion(repEffectiveProfileIds, 1),
      ])
    : [new Map(), new Map(), new Map()] as [
        Map<string, import("@/lib/crm/types").MonthlyGrowthPoint[]>,
        Map<string, import("@/lib/crm/types").MonthlyAovPoint[]>,
        Map<string, { points: import("@/lib/crm/types").CategoryConversionPoint[]; details: import("@/lib/crm/types").CategoryConversionDetail[] }>,
      ];
  const [growthMap, aovMap, conversionMap] = repTrendMaps;

  const collectionPreload = await preloadRepresentativeCollectionData(allEffectiveProfileIds);

  const currentMonthNewByRep = new Map<string, number>();
  for (const [repId, points] of growthMap) {
    if (points.length > 0) currentMonthNewByRep.set(repId, points[0].newCount);
  }
  const currentMonthAovByRep = new Map<string, number>();
  for (const [repId, points] of aovMap) {
    if (points.length > 0) currentMonthAovByRep.set(repId, points[0].avgOrderValue);
  }
  const currentMonthConversionRateByRep = new Map<string, number>();
  for (const [repId, { points }] of conversionMap) {
    if (points.length > 0) currentMonthConversionRateByRep.set(repId, points[0].conversionRate);
  }

  const collectionByRepId = new Map<string, CollectionSummaryMetrics>();
  for (const [repId, profileIds] of repEffectiveProfileIds) {
    collectionByRepId.set(
      repId,
      buildRepresentativeCollectionMetrics(
        profileIds,
        collectionPreload.pairs,
        collectionPreload.quarterReceivableMap,
        collectionPreload.yearReceivableMap,
      ),
    );
  }

  // ── Assemble results ─────────────────────────────────────────────
  let representatives = reps.map((rep) => {
    const linkedUser = emailToUser.get(rep.email);
    const userId = linkedUser?.id || null;
    const repId = rep.id;
    const lifecycleStats = repLifecycleStats.get(repId) ?? {
      orderedCustomerCount30d: 0,
      repeatCustomerCount30d: 0,
      orderedCustomerCount90d: 0,
      repeatCustomerCount90d: 0,
      activeCustomerCount: 0,
      newCustomerCount30d: 0,
      convertedCustomerCount30d: 0,
      newCustomerCount90d: 0,
      convertedCustomerCount90d: 0,
      dormantCustomerCount: 0,
      dormantWarningCustomerCount: 0,
    };
    const periodOrderCount = repPeriodOrderCountMap.get(repId) || 0;
    const periodRecognition = recognitionByRepId.get(repId) ?? {
      newBusinessCents: 0,
      deliveryBusinessCents: 0,
      confirmedBusinessCents: 0,
    };

    const effectiveCustomerCount = repCustomerCountMap.get(repId) || 0;

    // Communication coverage rate needs total effective customers as denominator
    const commCount = opsFactsByRep.get(repId)?.communicatedCustomerCount || 0;
    const commCoverageRate = effectiveCustomerCount > 0 ? commCount / effectiveCustomerCount : 0;

    const collection = collectionByRepId.get(repId) ?? EMPTY_COLLECTION_METRICS;

    return {
      representativeId: rep.id,
      name: rep.name,
      email: rep.email,
      archived: rep.archived,
      userId,
      userName: linkedUser?.name || null,
      customerCount: effectiveCustomerCount,
      visitCheckinCount: opsFactsByRep.get(repId)?.visitCheckinCount || 0,
      interactionCount30d: opsFactsByRep.get(repId)?.interactionCount || 0,
      lastCheckinAt: opsFactsByRep.get(repId)?.lastCheckinAt?.toISOString() ?? null,
      overdueFollowUps: opsFactsByRep.get(repId)?.overdueFollowUps || 0,
      longUnvisitedCount: opsFactsByRep.get(repId)?.longUnvisitedCount || 0,
      regions: rep.regionAssignments.map((a) => ({ id: a.region.id, name: a.region.name, isPrimary: a.isPrimary })),
      periodVisitCheckinCount: opsFactsByRep.get(repId)?.periodVisitCheckinCount || 0,
      periodInteractionCount: opsFactsByRep.get(repId)?.periodInteractionCount || 0,
      periodNewCustomerCount: repPeriodNewCustomerCountMap.get(repId) || 0,
      periodReservedOrderCount: periodOrderCount,
      // 金额一律分；*Cents 为主字段，旧字段名同步双写兼容
      periodReservedOrderAmountCents: repPeriodOrderAmountMap.get(repId) || 0,
      periodReservedOrderAmount: repPeriodOrderAmountMap.get(repId) || 0,
      periodNewBusinessAmountCents: periodRecognition.newBusinessCents,
      periodNewBusinessAmount: periodRecognition.newBusinessCents,
      periodDeliveryBusinessAmountCents: periodRecognition.deliveryBusinessCents,
      periodDeliveryBusinessAmount: periodRecognition.deliveryBusinessCents,
      periodConfirmedBusinessAmountCents: periodRecognition.confirmedBusinessCents,
      periodConfirmedBusinessAmount: periodRecognition.confirmedBusinessCents,
      dueCommunicationTaskCount: opsFactsByRep.get(repId)?.dueCommunicationTaskCount || 0,
      doneCommunicationTaskCount: opsFactsByRep.get(repId)?.doneCommunicationTaskCount || 0,
      overdueCommunicationTaskCount: opsFactsByRep.get(repId)?.overdueCommunicationTaskCount || 0,
      communicatedCustomerCount30d: commCount,
      communicationCoverageRate30d: commCoverageRate,
      activeCustomerCount: lifecycleStats.activeCustomerCount,
      newCustomerCount30d: lifecycleStats.newCustomerCount30d,
      convertedCustomerCount30d: lifecycleStats.convertedCustomerCount30d,
      conversionRate30d: lifecycleStats.newCustomerCount30d > 0
        ? lifecycleStats.convertedCustomerCount30d / lifecycleStats.newCustomerCount30d
        : 0,
      newCustomerCount90d: lifecycleStats.newCustomerCount90d,
      convertedCustomerCount90d: lifecycleStats.convertedCustomerCount90d,
      conversionRate90d: lifecycleStats.newCustomerCount90d > 0
        ? lifecycleStats.convertedCustomerCount90d / lifecycleStats.newCustomerCount90d
        : 0,
      orderedCustomerCount30d: lifecycleStats.orderedCustomerCount30d,
      repeatCustomerCount30d: lifecycleStats.repeatCustomerCount30d,
      repeatCustomerRate30d: lifecycleStats.orderedCustomerCount30d > 0
        ? lifecycleStats.repeatCustomerCount30d / lifecycleStats.orderedCustomerCount30d
        : 0,
      orderedCustomerCount90d: lifecycleStats.orderedCustomerCount90d,
      repeatCustomerCount90d: lifecycleStats.repeatCustomerCount90d,
      repeatCustomerRate90d: lifecycleStats.orderedCustomerCount90d > 0
        ? lifecycleStats.repeatCustomerCount90d / lifecycleStats.orderedCustomerCount90d
        : 0,
      dormantCustomerCount: lifecycleStats.dormantCustomerCount,
      dormantWarningCustomerCount: lifecycleStats.dormantWarningCustomerCount,
      currentMonthNewCustomers: currentMonthNewByRep.get(repId) ?? 0,
      currentMonthAovCents: currentMonthAovByRep.get(repId) ?? 0,
      currentMonthAov: currentMonthAovByRep.get(repId) ?? 0,
      currentMonthConversionRate: currentMonthConversionRateByRep.get(repId) ?? 0,
      avgCollectionCycleDays: collection.avgCollectionCycleDays,
      collectionPairCount: collection.collectionPairCount,
      quarterlyReceiptRate: collection.quarterlyReceiptRate,
      quarterlyReceiptAmount: collection.quarterlyReceiptAmount,
      quarterlyReceivableAmount: collection.quarterlyReceivableAmount,
      yearlyReceiptRate: collection.yearlyReceiptRate,
      yearlyReceiptAmount: collection.yearlyReceiptAmount,
      yearlyReceivableAmount: collection.yearlyReceivableAmount,
    };
  });

  // Post-filter: hasUser
  if (hasUserParam === "true") {
    representatives = representatives.filter((r) => r.userId !== null);
  } else if (hasUserParam === "false") {
    representatives = representatives.filter((r) => r.userId === null);
  }

  // Post-filter: hasOverdue
  if (hasOverdueParam === "true") {
    representatives = representatives.filter((r) => r.overdueFollowUps > 0);
  } else if (hasOverdueParam === "false") {
    representatives = representatives.filter((r) => r.overdueFollowUps === 0);
  }

  // Post-filter: hasLongUnvisited
  if (hasLongUnvisitedParam === "true") {
    representatives = representatives.filter((r) => r.longUnvisitedCount > 0);
  } else if (hasLongUnvisitedParam === "false") {
    representatives = representatives.filter((r) => r.longUnvisitedCount === 0);
  }

  // Sort
  const sortField = sort || "name";
  const sortOrder = order === "desc" ? -1 : 1;
  representatives.sort((a, b) => {
    let cmp = 0;
    switch (sortField) {
      case "name": cmp = a.name.localeCompare(b.name); break;
      case "customerCount": cmp = a.customerCount - b.customerCount; break;
      case "visitCheckinCount": cmp = a.visitCheckinCount - b.visitCheckinCount; break;
      case "interactionCount30d":
        cmp = (a.interactionCount30d || 0) - (b.interactionCount30d || 0); break;
      case "overdueFollowUps": cmp = a.overdueFollowUps - b.overdueFollowUps; break;
      case "longUnvisitedCount": cmp = a.longUnvisitedCount - b.longUnvisitedCount; break;
      default: cmp = a.name.localeCompare(b.name);
    }
    return cmp * sortOrder;
  });

  return NextResponse.json({ representatives });
}
