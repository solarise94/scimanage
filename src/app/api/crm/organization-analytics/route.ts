import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getRepresentativeCommunicationEvents } from "@/lib/crm/representative-communication-events";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = req.nextUrl;
  const search = searchParams.get("search") || "";
  const rangeDays = Math.min(365, Math.max(1, parseInt(searchParams.get("range") || "30") || 30));
  const sort = searchParams.get("sort") || "customerCount";
  const order = searchParams.get("order") || "desc";
  const page = Math.max(1, parseInt(searchParams.get("page") || "1") || 1);
  const pageSize = Math.min(100, Math.max(10, parseInt(searchParams.get("pageSize") || "20") || 20));

  const since = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000);
  const now = new Date();

  // Get all non-deleted, non-archived orgs
  const orgWhere: Record<string, unknown> = { deleted: false, archived: false };
  if (search) {
    orgWhere.OR = [
      { canonicalName: { contains: search } },
      { orgCode: { contains: search } },
      { aliases: { some: { alias: { contains: search } } } },
    ];
  }

  const orgs = await prisma.organization.findMany({
    where: orgWhere,
    select: { id: true, canonicalName: true, orgCode: true },
    orderBy: { canonicalName: "asc" },
  });

  const orgIds = orgs.map((o) => o.id);
  if (orgIds.length === 0) {
    return NextResponse.json({ organizations: [], total: 0, page, pageSize, totalPages: 0 });
  }

  // Batch 1: Customer counts per org
  const customerCounts = await prisma.crmCustomerProfile.groupBy({
    by: ["organizationId"],
    where: { organizationId: { in: orgIds }, deleted: false },
    _count: true,
  });
  const customerCountMap = new Map(customerCounts.map((c) => [c.organizationId, c._count]));

  // Batch 2: CRM profiles per org (Profile 主权 organizationId)
  const profiles = await prisma.crmCustomerProfile.findMany({
    where: {
      archived: false,
      deleted: false,
      organizationId: { in: orgIds },
    },
    select: {
      id: true,
      ownerUserId: true,
      assignmentStatus: true,
      organizationId: true,
    },
  });

  // Org → profile IDs + ownerUserIds (for rep counting only)
  const orgProfileIds = new Map<string, string[]>();
  const orgOwnerUserIds = new Map<string, Set<string>>();
  const orgAssignedCount = new Map<string, number>();
  const orgUnassignedCount = new Map<string, number>();

  for (const p of profiles) {
    const orgId = p.organizationId;
    if (!orgId) continue;

    const pids = orgProfileIds.get(orgId) || [];
    pids.push(p.id);
    orgProfileIds.set(orgId, pids);

    const owners = orgOwnerUserIds.get(orgId) || new Set<string>();
    if (p.ownerUserId) owners.add(p.ownerUserId);
    orgOwnerUserIds.set(orgId, owners);

    if (p.assignmentStatus === "ASSIGNED") {
      orgAssignedCount.set(orgId, (orgAssignedCount.get(orgId) || 0) + 1);
    } else if (p.assignmentStatus === "UNASSIGNED" || p.assignmentStatus === "RECALLED") {
      orgUnassignedCount.set(orgId, (orgUnassignedCount.get(orgId) || 0) + 1);
    }
  }

  const allProfileIds = profiles.map((p) => p.id);

  // Batch 3/4: 统一沟通事件（含 NOTE 与签到，排除签到派生 VISIT 重复）。
  const [rangeCommunicationEvents, allCommunicationEvents] = allProfileIds.length > 0
    ? await Promise.all([
        getRepresentativeCommunicationEvents({ profileIds: allProfileIds, from: since, to: now }),
        getRepresentativeCommunicationEvents({ profileIds: allProfileIds, from: new Date(0), to: now }),
      ])
    : [[], []];
  const profileInteractionMap = new Map<string, number>();
  const profileLastInteractionMap = new Map<string, Date>();
  for (const event of rangeCommunicationEvents) {
    profileInteractionMap.set(event.profileId, (profileInteractionMap.get(event.profileId) || 0) + 1);
  }
  for (const event of allCommunicationEvents) {
    const current = profileLastInteractionMap.get(event.profileId);
    if (!current || event.happenedAt > current) profileLastInteractionMap.set(event.profileId, event.happenedAt);
  }

  // Batch 5: Checkin counts per profile (not per user)
  const checkinAgg = allProfileIds.length > 0
    ? await prisma.crmVisitCheckin.groupBy({
        by: ["profileId"],
        where: { profileId: { in: allProfileIds }, createdAt: { gte: since }, status: "COMPLETED" },
        _count: true,
      })
    : [];
  const profileCheckinMap = new Map(checkinAgg.map((r) => [r.profileId, r._count]));

  // Batch 6: Last checkin per profile
  const lastCheckinAgg = allProfileIds.length > 0
    ? await prisma.crmVisitCheckin.groupBy({
        by: ["profileId"],
        where: { profileId: { in: allProfileIds }, status: "COMPLETED" },
        _max: { createdAt: true },
      })
    : [];
  const profileLastCheckinMap = new Map(lastCheckinAgg.map((r) => [r.profileId, r._max.createdAt]));

  // Batch 7: Representative count per org — distinct ownerUserIds that are sales users
  const allOwnerIds = [...new Set(
    profiles
      .map((p) => p.ownerUserId)
      .filter((id): id is string => id !== null),
  )];
  const repUsers = await prisma.user.findMany({
    where: { id: { in: allOwnerIds }, role: { in: ["REPRESENTATIVE", "REGIONAL_MANAGER"] } },
    select: { id: true },
  });
  const repUserIdSet = new Set(repUsers.map((u) => u.id));

  // Assemble per-org rows
  const rows = orgs.map((org) => {
    const profileIds = orgProfileIds.get(org.id) || [];
    const crmProfileCount = profileIds.length;
    const custCount = customerCountMap.get(org.id) || 0;
    const assigned = orgAssignedCount.get(org.id) || 0;
    const unassigned = orgUnassignedCount.get(org.id) || 0;

    let interactionCount = 0;
    let lastInteractionAt: Date | null = null;
    let checkinCount = 0;
    let lastCheckinAt: Date | null = null;

    for (const pid of profileIds) {
      interactionCount += profileInteractionMap.get(pid) || 0;
      const li = profileLastInteractionMap.get(pid);
      if (li && (!lastInteractionAt || li > lastInteractionAt)) lastInteractionAt = li;

      checkinCount += profileCheckinMap.get(pid) || 0;
      const lc = profileLastCheckinMap.get(pid);
      if (lc && (!lastCheckinAt || lc > lastCheckinAt)) lastCheckinAt = lc;
    }

    const ownerIds = orgOwnerUserIds.get(org.id) || new Set();
    let repCount = 0;
    for (const uid of ownerIds) {
      if (repUserIdSet.has(uid)) repCount++;
    }

    const visitDensity = crmProfileCount > 0 ? checkinCount / crmProfileCount : 0;
    const interactionDensity = crmProfileCount > 0 ? interactionCount / crmProfileCount : 0;

    const lastActivityAt: Date | null =
      (lastInteractionAt && lastCheckinAt)
        ? (lastInteractionAt > lastCheckinAt ? lastInteractionAt : lastCheckinAt)
        : (lastInteractionAt || lastCheckinAt || null);

    return {
      organizationId: org.id,
      canonicalName: org.canonicalName,
      orgCode: org.orgCode,
      customerCount: custCount,
      crmProfileCount,
      assignedProfileCount: assigned,
      unassignedProfileCount: unassigned,
      representativeCount: repCount,
      interactionCount,
      checkinCount,
      visitDensity: Math.round(visitDensity * 100) / 100,
      interactionDensity: Math.round(interactionDensity * 100) / 100,
      lastInteractionAt: lastInteractionAt?.toISOString() ?? null,
      lastCheckinAt: lastCheckinAt?.toISOString() ?? null,
      lastActivityAt: lastActivityAt?.toISOString() ?? null,
    };
  });

  // Sort
  const validSorts = ["customerCount", "crmProfileCount", "checkinCount", "interactionCount", "visitDensity", "interactionDensity", "lastActivityAt"];
  const sortField = validSorts.includes(sort) ? sort : "customerCount";
  const isDesc = order === "desc";
  rows.sort((a, b) => {
    const av = a[sortField as keyof typeof a];
    const bv = b[sortField as keyof typeof b];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") return isDesc ? bv - av : av - bv;
    if (typeof av === "string" && typeof bv === "string") return isDesc ? bv.localeCompare(av) : av.localeCompare(bv);
    return 0;
  });

  const total = rows.length;
  const totalPages = Math.ceil(total / pageSize);
  const paged = rows.slice((page - 1) * pageSize, page * pageSize);

  return NextResponse.json({ organizations: paged, total, page, pageSize, totalPages });
}
