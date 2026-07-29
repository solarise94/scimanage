import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getRepresentativeCommunicationEvents } from "@/lib/crm/representative-communication-events";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ organizationId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { organizationId } = await params;

  const org = await prisma.organization.findFirst({
    where: { id: organizationId, deleted: false },
    include: {
      aliases: true,
      sites: { where: { archived: false } },
      _count: { select: { crmProfiles: true } },
    },
  });
  if (!org) return NextResponse.json({ error: "Organization not found" }, { status: 404 });

  // CRM profiles for this org — 纯 Profile 主权：用 crmProfile.organizationId 过滤，
  // 业务字段（principal/labOrGroup/organization）从 Profile 本体读取，不读 sourceCustomer 旧列。
  const profiles = await prisma.crmCustomerProfile.findMany({
    where: {
      archived: false,
      deleted: false,
      organizationId,
    },
    select: {
      id: true,
      ownerUserId: true,
      stage: true,
      importance: true,
      personCategory: true,
      name: true,
      customerCode: true,
      principal: true,
      labOrGroup: true,
      organization: true,
      organizationSiteId: true,
      orgSite: { select: { id: true, siteName: true, siteType: true } },
      ownerUser: { select: { id: true, name: true } },
    },
  });

  const profileIds = profiles.map((p) => p.id);
  const ownerUserIds = [...new Set(
    profiles
      .map((p) => p.ownerUserId)
      .filter((id): id is string => id !== null),
  )];

  // Representative user mapping
  const salesUsers = await prisma.user.findMany({
    where: { id: { in: ownerUserIds }, role: { in: ["REPRESENTATIVE", "REGIONAL_MANAGER"] } },
    select: { id: true, name: true, email: true },
  });
  const userIdToSales = new Map(salesUsers.map((u) => [u.id, u]));

  const reps = await prisma.representative.findMany({
    where: { email: { in: salesUsers.map((u) => u.email) }, archived: false, kind: "HUMAN" },
    select: { id: true, name: true, email: true },
  });
  const emailToRep = new Map(reps.map((r) => [r.email, r]));

  // Per-representative: group profiles by owner
  const repProfileMap = new Map<string, string[]>(); // repId → profileIds
  for (const p of profiles) {
    if (!p.ownerUserId) continue;
    const sales = userIdToSales.get(p.ownerUserId);
    if (!sales) continue;
    const rep = emailToRep.get(sales.email);
    if (!rep) continue;
    const ids = repProfileMap.get(rep.id) || [];
    ids.push(p.id);
    repProfileMap.set(rep.id, ids);
  }

  // 统一沟通事件（含 NOTE 与签到，排除签到派生 VISIT 重复）。
  const d30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const now = new Date();
  const [communicationEvents, recentManualEvents] = profileIds.length > 0
    ? await Promise.all([
        getRepresentativeCommunicationEvents({ profileIds, from: d30, to: now }),
        getRepresentativeCommunicationEvents({ profileIds, from: new Date(0), to: now })
          .then((events) => events.filter((event) => event.sourceType === "INTERACTION").slice(0, 20)),
      ])
    : [[], []];
  const repInteractionMap = new Map<string, number>();
  for (const event of communicationEvents) {
    const salesUser = userIdToSales.get(event.actorUserId);
    const rep = salesUser ? emailToRep.get(salesUser.email) : null;
    if (!rep) continue;
    repInteractionMap.set(rep.id, (repInteractionMap.get(rep.id) || 0) + 1);
  }

  // Checkin counts per profile (30d) — NOT per user, so each checkin belongs to its profile's org
  const checkinAgg = profileIds.length > 0
    ? await prisma.crmVisitCheckin.groupBy({
        by: ["profileId"],
        where: { profileId: { in: profileIds }, createdAt: { gte: d30 }, status: "COMPLETED" },
        _count: true,
      })
    : [];
  const profileCheckinMap = new Map(checkinAgg.map((r) => [r.profileId, r._count]));

  // Last checkin per profile
  const lastCheckinAgg = profileIds.length > 0
    ? await prisma.crmVisitCheckin.groupBy({
        by: ["profileId"],
        where: { profileId: { in: profileIds }, status: "COMPLETED" },
        _max: { createdAt: true },
      })
    : [];
  const profileLastCheckinMap = new Map(lastCheckinAgg.map((r) => [r.profileId, r._max.createdAt]));

  // Per-representative metrics — checkins aggregated per rep's profiles in this org
  const representativeBreakdown = reps.map((rep) => {
    const pids = repProfileMap.get(rep.id) || [];
    const interactionCount = repInteractionMap.get(rep.id) || 0;
    let checkinCount = 0;
    let lastCheckin: Date | null = null;
    for (const pid of pids) {
      checkinCount += profileCheckinMap.get(pid) || 0;
      const lc = profileLastCheckinMap.get(pid);
      if (lc && (!lastCheckin || lc > lastCheckin)) lastCheckin = lc;
    }

    return {
      representativeId: rep.id,
      name: rep.name,
      email: rep.email,
      profileCount: pids.length,
      interactionCount,
      checkinCount,
      lastCheckinAt: lastCheckin?.toISOString?.() ?? null,
    };
  });

  // Stage / Importance / PersonCategory distributions
  const stageDist: Record<string, number> = {};
  const importanceDist: Record<string, number> = {};
  const personCategoryDist: Record<string, number> = {};
  for (const p of profiles) {
    stageDist[p.stage] = (stageDist[p.stage] || 0) + 1;
    importanceDist[p.importance] = (importanceDist[p.importance] || 0) + 1;
    const pc = p.personCategory || "未设置";
    personCategoryDist[pc] = (personCategoryDist[pc] || 0) + 1;
  }

  // 最近沟通只展示手工 interaction；签到在右侧独立列表展示。事件服务已剔除签到派生 VISIT，
  // 因而 NOTE 和手工 VISIT 均可见，签到不会在两个列表中重复出现。
  const recentInteractionRows = recentManualEvents.length > 0
    ? await prisma.crmInteraction.findMany({
        where: { id: { in: recentManualEvents.map((event) => event.sourceId) } },
        select: {
          id: true, type: true, summary: true, happenedAt: true,
          profile: { select: { id: true, name: true } },
          createdByUser: { select: { name: true } },
        },
      })
    : [];
  const interactionRowMap = new Map(recentInteractionRows.map((interaction) => [interaction.id, interaction]));
  const recentInteractions = recentManualEvents
    .map((event) => interactionRowMap.get(event.sourceId))
    .filter((interaction): interaction is NonNullable<typeof interaction> => !!interaction);

  // Recent checkins — scoped to this org's profiles
  const recentCheckins = profileIds.length > 0
    ? await prisma.crmVisitCheckin.findMany({
        where: { profileId: { in: profileIds }, status: "COMPLETED" },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true, summaryTitle: true, addressSnapshot: true, createdAt: true,
          user: { select: { name: true } },
        },
      })
    : [];

  return NextResponse.json({
    organization: {
      id: org.id,
      orgCode: org.orgCode,
      canonicalName: org.canonicalName,
      address: org.address,
      taxId: org.taxId,
      aliases: org.aliases,
      sites: org.sites,
      customerCount: org._count.crmProfiles,
      crmProfileCount: profiles.length,
    },
    customerSummary: profiles.slice(0, 100).map((p) => ({
      profileId: p.id,
      customerName: p.name,
      customerCode: p.customerCode,
      principal: p.principal,
      labOrGroup: p.labOrGroup,
      stage: p.stage,
      importance: p.importance,
      personCategory: p.personCategory,
      ownerName: p.ownerUser?.name ?? null,
      siteName: p.orgSite?.siteName ?? null,
      siteType: p.orgSite?.siteType ?? null,
    })),
    representativeBreakdown,
    recentInteractions,
    recentCheckins,
    distributions: {
      stage: stageDist,
      importance: importanceDist,
      personCategory: personCategoryDist,
    },
  });
}
