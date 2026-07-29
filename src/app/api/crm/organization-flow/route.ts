import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  getManagedRepresentativeIds,
  getRegionalManagerUserIds,
  getRepresentativeIdByUserEmail,
  isRegionalManagerRole,
} from "@/lib/crm/permissions";
import { resolveEffectiveRepresentativesForProfiles } from "@/lib/crm/customer-effective-representative";
import { getCrmLifecycleSummariesForProfiles } from "@/lib/crm/lifecycle";
import { CRM_EFFECTIVE_INTERACTION_TYPES } from "@/lib/crm/constants";

const D30_MS = 30 * 24 * 60 * 60 * 1000;

type FlowRowKey = string;

function rowKey(organizationId: string, organizationSiteId: string | null): FlowRowKey {
  return `${organizationId}::${organizationSiteId ?? ""}`;
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role === "REPRESENTATIVE") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = req.nextUrl;
  const search = searchParams.get("search")?.trim() || "";
  const bindingFilter = searchParams.get("bindingStatus") || "";
  const hasDormantWarning = searchParams.get("hasDormantWarning") || "";
  const page = Math.max(1, parseInt(searchParams.get("page") || "1") || 1);
  const pageSize = Math.min(100, Math.max(10, parseInt(searchParams.get("pageSize") || "20") || 20));
  const sort = searchParams.get("sort") || "customerCount";
  const order = searchParams.get("order") === "asc" ? "asc" : "desc";
  const organizationId = searchParams.get("organizationId")?.trim() || "";
  const siteId = searchParams.get("siteId")?.trim() || "";

  const orgWhere: Record<string, unknown> = { deleted: false, archived: false };
  if (organizationId) orgWhere.id = organizationId;
  if (search) {
    orgWhere.OR = [
      { canonicalName: { contains: search } },
      { orgCode: { contains: search } },
      { aliases: { some: { alias: { contains: search } } } },
    ];
  }

  const orgs = await prisma.organization.findMany({
    where: orgWhere,
    select: {
      id: true,
      canonicalName: true,
      orgCode: true,
      sites: {
        where: { archived: false },
        select: { id: true, siteName: true, siteType: true },
        orderBy: { siteName: "asc" },
      },
    },
    orderBy: { canonicalName: "asc" },
  });

  const orgIds = orgs.map((o) => o.id);
  if (orgIds.length === 0) {
    return NextResponse.json({ rows: [], total: 0, page, pageSize, totalPages: 0 });
  }

  const profiles = await prisma.crmCustomerProfile.findMany({
    where: {
      archived: false,
      deleted: false,
      organizationId: { in: orgIds },
    },
    select: {
      id: true,
      organizationId: true,
      organizationSiteId: true,
      lastFollowUpAt: true,
      ownerUserId: true,
    },
  });

  const isRM = isRegionalManagerRole(session.user.role);
  let visibleProfiles = profiles;

  if (isRM) {
    const repUserIds = await getRegionalManagerUserIds(session.user.id);
    const allowedOwnerUserIds = new Set([session.user.id, ...(repUserIds || [])]);
    const profileEffectiveMap = await resolveEffectiveRepresentativesForProfiles(
      profiles.map((p) => p.id),
    );
    visibleProfiles = profiles.filter((p) => {
      const effectiveOwnerId = profileEffectiveMap.get(p.id)?.ownerUserId;
      return effectiveOwnerId != null && allowedOwnerUserIds.has(effectiveOwnerId);
    });
  }

  const lifecycleMap = await getCrmLifecycleSummariesForProfiles(
    visibleProfiles.map((profile) => profile.id),
  );

  const now = Date.now();
  const d30 = new Date(now - D30_MS);

  const profileIds = visibleProfiles.map((p) => p.id);
  const recentInteractions = profileIds.length > 0
    ? await prisma.crmInteraction.findMany({
        where: {
          profileId: { in: profileIds },
          type: { in: CRM_EFFECTIVE_INTERACTION_TYPES as unknown as string[] },
          happenedAt: { gte: d30 },
        },
        select: { profileId: true },
        distinct: ["profileId"],
      })
    : [];
  const communicatedProfileIds = new Set(recentInteractions.map((i) => i.profileId));

  // RM 只能看下辖代表（含自身代表 id）的绑定行；提前解析并下推 WHERE，避免全量取出再内存 filter
  const rmScopedRepresentativeIds = isRM
    ? new Set(await getManagedRepresentativeIds(session.user.id))
    : null;
  if (isRM && session.user.email) {
    const ownRepId = await getRepresentativeIdByUserEmail(session.user.email);
    if (ownRepId) rmScopedRepresentativeIds!.add(ownRepId);
  }

  const bindings = await prisma.representativeOrganization.findMany({
    where: {
      organizationId: { in: orgIds },
      status: { in: ["ACTIVE", "PENDING"] },
      ...(rmScopedRepresentativeIds && rmScopedRepresentativeIds.size > 0
        ? { representativeId: { in: [...rmScopedRepresentativeIds] } }
        : {}),
    },
    include: {
      representative: { select: { id: true, name: true, email: true } },
      organizationSite: { select: { id: true, siteName: true, siteType: true } },
    },
    orderBy: [{ status: "asc" }, { isPrimary: "desc" }, { createdAt: "asc" }],
  });

  // RM 解析出空集合时（无下辖且自身无代表 id）→ DB WHERE 不可下推 → 兜底返回空，避免泄露全量
  const visibleBindings = isRM && rmScopedRepresentativeIds && rmScopedRepresentativeIds.size === 0
    ? []
    : bindings;

  type Agg = {
    organizationId: string;
    organizationSiteId: string | null;
    customerCount: number;
    recentOrderedCustomerCount: number;
    dormantWarningCustomerCount: number;
    uncommunicatedCustomerCount: number;
    lastHistoricalOrderAt: Date | null;
  };

  const aggMap = new Map<FlowRowKey, Agg>();

  function ensureAgg(organizationId: string, organizationSiteId: string | null): Agg {
    const key = rowKey(organizationId, organizationSiteId);
    let agg = aggMap.get(key);
    if (!agg) {
      agg = {
        organizationId,
        organizationSiteId,
        customerCount: 0,
        recentOrderedCustomerCount: 0,
        dormantWarningCustomerCount: 0,
        uncommunicatedCustomerCount: 0,
        lastHistoricalOrderAt: null,
      };
      aggMap.set(key, agg);
    }
    return agg;
  }

  for (const profile of visibleProfiles) {
    const orgId = profile.organizationId;
    if (!orgId) continue;
    const siteId = profile.organizationSiteId;
    const agg = ensureAgg(orgId, siteId);
    agg.customerCount += 1;

    const lifecycle = lifecycleMap.get(profile.id);
    const lastHistoricalOrderAt = lifecycle?.lastHistoricalOrderAt ?? null;
    if (lastHistoricalOrderAt && lastHistoricalOrderAt >= d30) {
      agg.recentOrderedCustomerCount += 1;
    }
    if (lifecycle?.dormantRisk) {
      agg.dormantWarningCustomerCount += 1;
    }
    if (!communicatedProfileIds.has(profile.id)) {
      agg.uncommunicatedCustomerCount += 1;
    }
    if (lastHistoricalOrderAt && (!agg.lastHistoricalOrderAt || lastHistoricalOrderAt > agg.lastHistoricalOrderAt)) {
      agg.lastHistoricalOrderAt = lastHistoricalOrderAt;
    }
  }

  for (const binding of visibleBindings) {
    if (!binding.organizationId) continue;
    ensureAgg(binding.organizationId, binding.organizationSiteId);
  }

  const orgMap = new Map(orgs.map((o) => [o.id, o]));
  const bindingsByKey = new Map<FlowRowKey, typeof bindings>();
  for (const binding of visibleBindings) {
    if (!binding.organizationId) continue;
    const key = rowKey(binding.organizationId, binding.organizationSiteId);
    const list = bindingsByKey.get(key) || [];
    list.push(binding);
    bindingsByKey.set(key, list);
  }

  let rows = [...aggMap.values()].map((agg) => {
    const org = orgMap.get(agg.organizationId);
    const site = agg.organizationSiteId
      ? org?.sites.find((s) => s.id === agg.organizationSiteId) ?? null
      : null;
    const keyBindings = bindingsByKey.get(rowKey(agg.organizationId, agg.organizationSiteId)) || [];
    const activeBindings = keyBindings.filter((b) => b.status === "ACTIVE");
    const pendingBindings = keyBindings.filter((b) => b.status === "PENDING");
    const primaryBinding = activeBindings.find((b) => b.isPrimary) || activeBindings[0] || null;

    let bindingStatus: "unbound" | "bound" | "pending" | "conflict" = "unbound";
    if (activeBindings.length > 1) bindingStatus = "conflict";
    else if (activeBindings.length === 1) bindingStatus = "bound";
    else if (pendingBindings.length > 0) bindingStatus = "pending";

    return {
      organizationId: agg.organizationId,
      organizationName: org?.canonicalName || agg.organizationId,
      orgCode: org?.orgCode || "",
      organizationSiteId: agg.organizationSiteId,
      siteName: site?.siteName || null,
      siteType: site?.siteType || null,
      bindingStatus,
      representative: primaryBinding
        ? {
            id: primaryBinding.representative.id,
            name: primaryBinding.representative.name,
            email: primaryBinding.representative.email,
            bindingId: primaryBinding.id,
            isPrimary: primaryBinding.isPrimary,
          }
        : null,
      activeBindingCount: activeBindings.length,
      pendingBindingCount: pendingBindings.length,
      customerCount: agg.customerCount,
      recentOrderedCustomerCount: agg.recentOrderedCustomerCount,
      dormantWarningCustomerCount: agg.dormantWarningCustomerCount,
      uncommunicatedCustomerCount: agg.uncommunicatedCustomerCount,
      lastHistoricalOrderAt: agg.lastHistoricalOrderAt?.toISOString() ?? null,
    };
  });

  if (bindingFilter === "unbound") {
    rows = rows.filter((r) => r.bindingStatus === "unbound" || r.bindingStatus === "pending");
  } else if (bindingFilter === "bound") {
    rows = rows.filter((r) => r.bindingStatus === "bound");
  } else if (bindingFilter === "pending") {
    rows = rows.filter((r) => r.pendingBindingCount > 0);
  } else if (bindingFilter === "conflict") {
    rows = rows.filter((r) => r.bindingStatus === "conflict");
  }

  if (hasDormantWarning === "true") {
    rows = rows.filter((r) => r.dormantWarningCustomerCount > 0);
  } else   if (hasDormantWarning === "false") {
    rows = rows.filter((r) => r.dormantWarningCustomerCount === 0);
  }

  if (siteId) {
    rows = rows.filter((r) => r.organizationSiteId === siteId);
  }

  const validSorts = [
    "customerCount",
    "recentOrderedCustomerCount",
    "dormantWarningCustomerCount",
    "uncommunicatedCustomerCount",
    "lastHistoricalOrderAt",
    "organizationName",
  ] as const;
  const sortField = validSorts.includes(sort as typeof validSorts[number]) ? sort : "customerCount";
  rows.sort((a, b) => {
    const av = a[sortField as keyof typeof a];
    const bv = b[sortField as keyof typeof b];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") {
      return order === "asc" ? av - bv : bv - av;
    }
    if (typeof av === "string" && typeof bv === "string") {
      return order === "asc" ? av.localeCompare(bv, "zh-CN") : bv.localeCompare(av, "zh-CN");
    }
    return 0;
  });

  const total = rows.length;
  const totalPages = Math.ceil(total / pageSize);
  const paged = rows.slice((page - 1) * pageSize, page * pageSize);

  return NextResponse.json({ rows: paged, total, page, pageSize, totalPages });
}
