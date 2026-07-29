import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { Prisma } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { deriveGraduationStatus, buildGraduationStatusWhere } from "@/lib/crm/profile-filters";
import { syncProfileRepresentativeLinksFromOwner } from "@/lib/crm/customer-representative-sync";
import { syncManagingTagForProfileOwner } from "@/lib/crm/customer-rep-tag-helpers";
import { assertRepresentativeBackedSalesUser } from "@/lib/representative-user";
import { createCrmCustomerProfile } from "@/lib/crm/create-profile";
import { getCrmLifecycleSummariesForProfiles } from "@/lib/crm/lifecycle";
import { resolveEffectiveRepresentativesForProfiles } from "@/lib/crm/customer-effective-representative";
import { isRegionalManagerRole, isRepresentativeRole, getEffectiveCrmVisibleProfileIds } from "@/lib/crm/permissions";
import { filterByPinyin } from "@/lib/crm/pinyin-search";
import { profileInclude } from "@/lib/crm/includes";
import { buildCrmProfileCustomerView } from "@/lib/customers/customer-business-fields";
import { toPublicProfile } from "@/lib/crm/public-dto";

type LifecycleSummaryMap = Awaited<ReturnType<typeof getCrmLifecycleSummariesForProfiles>>;

function matchesLifecycleFilters(
  lifecycle: LifecycleSummaryMap extends Map<string, infer TValue> ? TValue | undefined : never,
  filters: {
    hasOrder: string;
    repeatCustomer: string;
    dormantRisk: string;
    communicationDue: string;
  },
) {
  const historicalOrderCount = lifecycle?.historicalOrderCount ?? 0;
  const isRepeat = lifecycle?.isRepeatCustomer ?? false;
  const isDormantRisk = lifecycle?.dormantRisk ?? false;
  const hasCommunicationDue = Boolean(lifecycle?.nextCommunicationTaskAt);

  if (filters.hasOrder === "true" && historicalOrderCount <= 0) return false;
  if (filters.hasOrder === "false" && historicalOrderCount > 0) return false;
  if (filters.repeatCustomer === "true" && !isRepeat) return false;
  if (filters.repeatCustomer === "false" && isRepeat) return false;
  if (filters.dormantRisk === "true" && !isDormantRisk) return false;
  if (filters.dormantRisk === "false" && isDormantRisk) return false;
  if (filters.communicationDue === "true" && !hasCommunicationDue) return false;
  if (filters.communicationDue === "false" && hasCommunicationDue) return false;

  return true;
}

function enrichProfiles<
  T extends {
    id: string;
    personCategory: string | null;
    graduationDate: Date | null;
    lastOrderAt: Date | null;
  },
>(
  profiles: T[],
  lifecycleMap: LifecycleSummaryMap,
) {
  return profiles.map((profile) => {
    const lifecycle = lifecycleMap.get(profile.id);
    return {
      ...profile,
      graduationStatus: deriveGraduationStatus(profile.personCategory, profile.graduationDate),
      historicalOrderCount: lifecycle?.historicalOrderCount ?? 0,
      lastHistoricalOrderAt: lifecycle?.lastHistoricalOrderAt?.toISOString() ?? null,
      isRepeatCustomer: lifecycle?.isRepeatCustomer ?? false,
      dormantRisk: lifecycle?.dormantRisk ?? false,
      nextCommunicationTaskAt: lifecycle?.nextCommunicationTaskAt?.toISOString() ?? null,
    };
  });
}

function compareNullableDates(left: Date | null, right: Date | null, sortOrder: "asc" | "desc") {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return sortOrder === "asc" ? left.getTime() - right.getTime() : right.getTime() - left.getTime();
}

function compareNumbers(left: number, right: number, sortOrder: "asc" | "desc") {
  return sortOrder === "asc" ? left - right : right - left;
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const search = searchParams.get("search") || "";
  const stage = searchParams.get("stage") || "";
  const importance = searchParams.get("importance") || "";
  const ownerUserId = searchParams.get("ownerUserId") || "";
  const assignee = searchParams.get("assignee") || "";
  // 旧 *CustomerId 系筛选参数一律 400（键名枚举，避免在源码里引用已废弃契约）。
  const legacyParam = [...searchParams.keys()].find((k) => /customerids?$/i.test(k));
  if (legacyParam) {
    return NextResponse.json(
      { error: `请使用 profileId 筛选客户档案（不再接受 ${legacyParam}）` },
      { status: 400 },
    );
  }
  const organizationId = searchParams.get("organizationId") || "";
  const siteId = searchParams.get("siteId") || "";
  const personCategory = searchParams.get("personCategory") || "";
  const jobTitle = searchParams.get("jobTitle") || "";
  const graduationStatus = searchParams.get("graduationStatus") || "";
  const graduationDateFrom = searchParams.get("graduationDateFrom") || "";
  const graduationDateTo = searchParams.get("graduationDateTo") || "";
  const hasOrder = searchParams.get("hasOrder") || "";
  const repeatCustomer = searchParams.get("repeatCustomer") || "";
  const dormantRisk = searchParams.get("dormantRisk") || "";
  const communicationDue = searchParams.get("communicationDue") || "";
  const hasOpenComplaint = searchParams.get("hasOpenComplaint") || "";
  const hasHighRiskComplaint = searchParams.get("hasHighRiskComplaint") || "";
  const showArchived = searchParams.get("archived") === "true";
  const includeDeleted = searchParams.get("includeDeleted") === "true";
  if (includeDeleted && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "仅管理员可查看已删除客户" }, { status: 403 });
  }
  const sort = searchParams.get("sort") || "updatedAt";
  const order = searchParams.get("order") || "desc";
  const page = Math.max(1, parseInt(searchParams.get("page") || "1") || 1);
  const pageSize = Math.min(100, Math.max(10, parseInt(searchParams.get("pageSize") || "50") || 50));

  const isScoped = isRepresentativeRole(session.user.role) || isRegionalManagerRole(session.user.role);

  // Build filters that can be expressed in Prisma WHERE
  const andConditions: Record<string, unknown>[] = [];
  if (!showArchived) andConditions.push({ archived: false });
  // Profile 自身生命周期（W5.2：不再要求 sourceCustomer 存活）
  if (!includeDeleted) {
    andConditions.push({ deleted: false });
  }
  if (stage) andConditions.push({ stage });
  if (importance) andConditions.push({ importance });
  if (personCategory) andConditions.push({ personCategory });
  if (jobTitle) andConditions.push({ jobTitle: { contains: jobTitle } });
  if (graduationDateFrom || graduationDateTo) {
    const dateRange: Record<string, Date> = {};
    if (graduationDateFrom) dateRange.gte = new Date(graduationDateFrom);
    if (graduationDateTo) dateRange.lte = new Date(graduationDateTo);
    andConditions.push({ graduationDate: dateRange });
  }
  if (graduationStatus) {
    const gradWhere = buildGraduationStatusWhere(graduationStatus);
    if (gradWhere) andConditions.push(gradWhere);
  }
  // Phase 4：客诉筛选（直接查 CrmComplaint 关系）
  if (hasOpenComplaint === "true") {
    andConditions.push({
      complaints: { some: { status: { in: ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED"] } } },
    });
  }
  if (hasHighRiskComplaint === "true") {
    andConditions.push({
      complaints: {
        some: {
          status: { in: ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED"] },
          severity: { in: ["HIGH", "CRITICAL"] },
        },
      },
    });
  }

  // Phase 2.1: 机构字段（organization/organizationId/organizationSiteId）
  // 主权已迁到 CrmCustomerProfile；筛选直接加在 Profile 上，不走 sourceCustomer。
  if (organizationId) andConditions.push({ organizationId });
  if (siteId) andConditions.push({ organizationSiteId: siteId });

  // 身份/机构搜索只查 Profile 主权字段；Customer 同名旧列不再参与运行时兜底。
  if (search) {
    andConditions.push({
      OR: [
        { name: { contains: search } },
        { customerCode: { contains: search } },
        { organization: { contains: search } },
        { principal: { contains: search } },
        // P2：常用称呼/历史姓名搜索（docs §8），只搜活动 alias
        { nameAliases: { some: { alias: { contains: search }, active: true } } },
      ],
    });
  }

  // Note: we no longer filter by ownerUserId/assignee at the DB level.
  // Effective representative filtering is applied after resolution.

  const where: Record<string, unknown> =
    andConditions.length === 0
      ? {}
      : andConditions.length === 1
        ? andConditions[0]
        : { AND: andConditions };

  // Phase 2.1: pinyin fallback — same filters minus the text-search OR block.
  // orgId/siteId are now direct Profile conditions (preserved); search OR is removed.
  const pinyinAndConditions: Record<string, unknown>[] = andConditions.filter(
    (c) => !("OR" in c),
  );
  const pinyinWhere: Record<string, unknown> =
    pinyinAndConditions.length === 0
      ? {}
      : pinyinAndConditions.length === 1
        ? pinyinAndConditions[0]
        : { AND: pinyinAndConditions };

  const validSorts = ["updatedAt", "createdAt", "lastFollowUpAt", "nextFollowUpAt", "stage", "lastHistoricalOrderAt", "historicalOrderCount"];
  const sortField = validSorts.includes(sort) ? sort : "updatedAt";
  const sortOrder = order === "asc" ? "asc" : "desc";
  const lifecycleFilters = { hasOrder, repeatCustomer, dormantRisk, communicationDue };
  const hasLifecycleFilters = Object.values(lifecycleFilters).some(Boolean);
  const usesLifecycleSort = sortField === "lastHistoricalOrderAt" || sortField === "historicalOrderCount";

  // Step 1: Query all candidate profiles (without owner filter)
  const candidates = await prisma.crmCustomerProfile.findMany({
    where,
    select: {
      id: true,
      ownerUserId: true,
      updatedAt: true,
    },
    orderBy: usesLifecycleSort
      ? [{ updatedAt: "desc" }]
      : [{ [sortField]: sortOrder }],
  });

  // Step 1b: Pinyin fallback — if search is active, fetch additional candidates
  // whose name matches via pinyin initials (e.g. "zsy" → "张三阳")
  if (search) {
    const existingIds = new Set(candidates.map((c) => c.id));
    const pinyinCandidates = await prisma.crmCustomerProfile.findMany({
      where: pinyinWhere,
      select: {
        id: true,
        ownerUserId: true,
        updatedAt: true,
        name: true,
      },
    });
    const pinyinMatches = filterByPinyin(
      pinyinCandidates.map((p) => ({
        ...p,
        name: p.name || "",
      })),
      search,
      existingIds,
    );
    for (const match of pinyinMatches) {
      candidates.push({
        id: match.id,
        ownerUserId: match.ownerUserId,
        updatedAt: match.updatedAt,
      });
    }
  }

  // Step 2: Resolve effective representatives for all candidates (profile-keyed)
  const candidateProfileIds = candidates.map((p) => p.id);
  const profileEffectiveMap = await resolveEffectiveRepresentativesForProfiles(candidateProfileIds);

  // Step 3: Filter by effective owner for scoped roles and assignee filter.
  const visibleProfileIdSet = isScoped
    ? await getEffectiveCrmVisibleProfileIds(session.user.id, session.user.role)
    : null;

  let filteredCandidates = candidates.filter((p) => {
    const effOwnerId = profileEffectiveMap.get(p.id)?.ownerUserId;

    if (assignee === "UNASSIGNED") {
      if (effOwnerId) return false;
    } else if (assignee) {
      if (effOwnerId !== assignee) return false;
    } else if (ownerUserId) {
      if (effOwnerId !== ownerUserId) return false;
    }

    if (visibleProfileIdSet !== null) {
      return visibleProfileIdSet.has(p.id);
    }

    return true;
  });

  // Step 4: Lifecycle filtering / sorting（按 profileId，批量聚合）
  let lifecycleMap: LifecycleSummaryMap = new Map();
  if (hasLifecycleFilters || usesLifecycleSort) {
    lifecycleMap = await getCrmLifecycleSummariesForProfiles(
      filteredCandidates.map((p) => p.id),
    );

    if (hasLifecycleFilters) {
      filteredCandidates = filteredCandidates.filter((p) =>
        matchesLifecycleFilters(lifecycleMap.get(p.id), lifecycleFilters),
      );
    }

    if (usesLifecycleSort) {
      filteredCandidates.sort((left, right) => {
        const leftLifecycle = lifecycleMap.get(left.id);
        const rightLifecycle = lifecycleMap.get(right.id);
        const primary = sortField === "lastHistoricalOrderAt"
          ? compareNullableDates(leftLifecycle?.lastHistoricalOrderAt ?? null, rightLifecycle?.lastHistoricalOrderAt ?? null, sortOrder as "asc" | "desc")
          : compareNumbers(leftLifecycle?.historicalOrderCount ?? 0, rightLifecycle?.historicalOrderCount ?? 0, sortOrder as "asc" | "desc");
        if (primary !== 0) return primary;
        return right.updatedAt.getTime() - left.updatedAt.getTime();
      });
    }
  }

  // Step 5: Pagination — 无生命周期筛选/排序时只对当前页拉 lifecycle，避免全量扫描
  const total = filteredCandidates.length;
  const pageCandidateIds = filteredCandidates.slice((page - 1) * pageSize, page * pageSize);

  if (!hasLifecycleFilters && !usesLifecycleSort && pageCandidateIds.length > 0) {
    lifecycleMap = await getCrmLifecycleSummariesForProfiles(
      pageCandidateIds.map((p) => p.id),
    );
  }

  // 安全基础条件：Profile archived/deleted 默认隐藏。
  // 不复用含搜索 OR / lifecycle 的 where —— 否则 pinyin fallback 命中的候选
  // （Profile.name 为空）会被搜索 OR 二次过滤掉（R1 配套修复）。
  const baseWhere: Record<string, unknown> = {};
  if (!showArchived) baseWhere.archived = false;
  if (!includeDeleted) {
    baseWhere.deleted = false;
  }

  let pagedProfiles: Prisma.CrmCustomerProfileGetPayload<{ include: typeof profileInclude }>[];
  if (pageCandidateIds.length === 0) {
    pagedProfiles = [];
  } else {
    const pageOrder = new Map(pageCandidateIds.map((c, index) => [c.id, index]));
    const fetchedProfiles = await prisma.crmCustomerProfile.findMany({
      where: {
        ...baseWhere,
        id: { in: pageCandidateIds.map((c) => c.id) },
      },
      include: profileInclude,
      orderBy: usesLifecycleSort ? { updatedAt: "desc" } : { [sortField]: sortOrder },
    });
    pagedProfiles = fetchedProfiles.sort(
      (left, right) =>
        (pageOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER)
        - (pageOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    );
  }

  const enriched = enrichProfiles(pagedProfiles, lifecycleMap);

  const profilesWithView = enriched.map((p) => ({
    ...toPublicProfile(p),
    customerView: buildCrmProfileCustomerView(p),
  }));

  return NextResponse.json({
    profiles: profilesWithView,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  // 旧 *CustomerId 系参数一律 400（键名枚举，避免在源码里引用已废弃契约）。
  const legacyKey = Object.keys(body as Record<string, unknown>).find((k) => /customerids?$/i.test(k));
  if (legacyKey) {
    return NextResponse.json(
      { error: `不再接受 ${legacyKey}，请直接创建 Profile` },
      { status: 400 },
    );
  }
  const {
    name,
    ownerUserId,
    organizationId,
    organization,
    importance,
    stage,
  } = body;

  if (typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  if (isRegionalManagerRole(session.user.role)) {
    return NextResponse.json({ error: "地区经理不能创建客户档案，只能管理已分配的客户" }, { status: 403 });
  }

  const finalOwner = session.user.role === "REPRESENTATIVE" ? session.user.id : ownerUserId;
  if (!finalOwner) {
    return NextResponse.json({ error: "ownerUserId is required" }, { status: 400 });
  }
  try {
    await assertRepresentativeBackedSalesUser(finalOwner);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "负责人无效" }, { status: 400 });
  }

  const result = await prisma.$transaction(async (tx) => {
    const created = await createCrmCustomerProfile({
      name: name.trim(),
      ownerUserId: finalOwner,
      organizationId: typeof organizationId === "string" ? organizationId : null,
      organization: typeof organization === "string" ? organization : null,
      stage: typeof stage === "string" ? stage : "LEAD",
      importance:
        session.user.role === "REPRESENTATIVE"
          ? "NORMAL"
          : typeof importance === "string"
            ? importance
            : "NORMAL",
      assignmentStatus: "ASSIGNED",
      sourceHint: "MANUAL",
    }, tx);

    await syncProfileRepresentativeLinksFromOwner(created.id, finalOwner, tx);
    await syncManagingTagForProfileOwner(tx, {
      profileId: created.id,
      ownerUserId: finalOwner,
      actingUserId: session.user.id,
      note: "CRM Profile-only 创建：负责人同步",
    });

    return tx.crmCustomerProfile.findUniqueOrThrow({
      where: { id: created.id },
      include: profileInclude,
    });
  });

  return NextResponse.json(
    {
      profile: {
        ...toPublicProfile(result as unknown as Record<string, unknown>),
        customerView: buildCrmProfileCustomerView(result),
      },
    },
    { status: 201 },
  );
}
