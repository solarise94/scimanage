import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isRepresentative } from "@/lib/permissions";
import { getRepresentativeIdByUserEmail } from "@/lib/crm/permissions";
import { Prisma } from "@prisma/client";
import {
  normalizeOrgName,
  normalizeOrganizationLookupText,
  organizationLookupIncludes,
} from "@/lib/organization-normalize";

type Availability = "AVAILABLE" | "OWN_ACTIVE" | "OWN_PENDING" | "OTHER_ACTIVE" | "OTHER_PENDING";

const AVAILABILITY_LABEL: Record<Availability, string> = {
  AVAILABLE: "可申请",
  OWN_ACTIVE: "已绑定到你",
  OWN_PENDING: "你已提交申请",
  OTHER_ACTIVE: "已被其他代表绑定",
  OTHER_PENDING: "已有其他代表申请中",
};

function matchesOrganizationSearch(
  o: { canonicalName: string; orgCode: string; aliases: Array<{ alias: string }> },
  keySearch: string,
  lookupSearch: string,
): boolean {
  if (!lookupSearch && !keySearch) return true;
  const keyHit =
    !!keySearch &&
    (normalizeOrgName(o.canonicalName).includes(keySearch) ||
      normalizeOrgName(o.orgCode).includes(keySearch) ||
      o.aliases.some((a) => normalizeOrgName(a.alias).includes(keySearch)));
  const lookupHit =
    !!lookupSearch &&
    (organizationLookupIncludes(o.canonicalName, lookupSearch) ||
      organizationLookupIncludes(o.orgCode, lookupSearch) ||
      o.aliases.some((a) => organizationLookupIncludes(a.alias, lookupSearch)));
  return keyHit || lookupHit;
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const rawSearch = searchParams.get("search")?.trim() || "";
  const lookupSearch = normalizeOrganizationLookupText(rawSearch);
  const keySearch = normalizeOrgName(rawSearch);
  const isAdmin = searchParams.get("admin") === "1";
  const excludeIdsRaw = searchParams.get("excludeIds")?.trim() || "";
  const userIsRep = isRepresentative(session.user.role);

  if (isAdmin) {
    const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
    if (!user || user.role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  if (userIsRep && lookupSearch.length < 2) {
    return NextResponse.json({ organizations: [] });
  }

  const where: Prisma.OrganizationWhereInput = {
    deleted: false,
    archived: false,
  };

  if (keySearch || lookupSearch) {
    // Prefer indexed normalized keys (same algorithm as stored matching keys).
    // Keep raw contains as a bridge for pre-backfill rows.
    const or: Prisma.OrganizationWhereInput[] = [
      { normalizedName: { contains: keySearch } },
      { orgCode: { contains: keySearch } },
      { aliases: { some: { normalizedAlias: { contains: keySearch } } } },
      { canonicalName: { contains: rawSearch } },
      { aliases: { some: { alias: { contains: rawSearch } } } },
    ];
    if (keySearch && keySearch !== rawSearch) {
      or.push({ canonicalName: { contains: keySearch } });
      or.push({ aliases: { some: { alias: { contains: keySearch } } } });
    }
    where.OR = or;
  }

  if (isAdmin && excludeIdsRaw) {
    const excludeIds = excludeIdsRaw.split(",").filter(Boolean);
    if (excludeIds.length) {
      where.id = { notIn: excludeIds };
    }
  }

  const take = isAdmin ? 100 : (userIsRep ? 20 : 50);
  // Over-fetch then filter so NFKC/ZWSP 搜索在内存层仍可命中；截断前保留 filtered total。
  const fetchTake = keySearch || lookupSearch ? Math.min(take * 5, 500) : take;

  const [candidates, totalRaw] = await Promise.all([
    prisma.organization.findMany({
      where,
      select: {
        id: true,
        orgCode: true,
        canonicalName: true,
        address: true,
        taxId: true,
        aliases: { select: { alias: true } },
        ...(isAdmin ? {
          _count: { select: { sites: true } },
        } : {}),
      },
      orderBy: { canonicalName: "asc" },
      take: fetchTake,
    }),
    isAdmin ? prisma.organization.count({ where }) : Promise.resolve(0),
  ]);

  const filteredAll =
    keySearch || lookupSearch
      ? candidates.filter((o) => matchesOrganizationSearch(o, keySearch, lookupSearch))
      : candidates;
  const organizations = filteredAll.slice(0, take);
  const sqlCapped = !!(keySearch || lookupSearch) && candidates.length >= fetchTake;
  // When SQL 候选触顶，filteredAll.length 不是真实总数，勿当作精确 total。
  const totalExact = isAdmin
    ? (keySearch || lookupSearch ? filteredAll.length : totalRaw)
    : null;
  const total = isAdmin ? (sqlCapped ? null : totalExact) : null;
  const totalIsExact = isAdmin ? !sqlCapped : true;
  const limited = isAdmin && (
    keySearch || lookupSearch
      ? filteredAll.length > take || sqlCapped
      : totalRaw > take
  );

  if (!userIsRep) {
    if (isAdmin) {
      return NextResponse.json({
        organizations: organizations.map((o) => {
          const { aliases: _aliases, ...rest } = o;
          void _aliases;
          return {
            ...rest,
            siteCount: (o as unknown as { _count?: { sites: number } })._count?.sites ?? 0,
          };
        }),
        total,
        totalIsExact,
        limited,
      });
    }
    return NextResponse.json({
      organizations: organizations.map(({ aliases: _a, ...rest }) => {
        void _a;
        return rest;
      }),
    });
  }

  // Representative: augment with availability info
  const ownRepId = await getRepresentativeIdByUserEmail(session.user.email);
  const orgIds = organizations.map((o) => o.id);

  const bindings = orgIds.length
    ? await prisma.representativeOrganization.findMany({
        where: {
          organizationId: { in: orgIds },
          status: { in: ["ACTIVE", "PENDING"] },
        },
        select: { representativeId: true, organizationId: true, status: true },
      })
    : [];

  const bindingMap = new Map<string, { repId: string; status: string }[]>();
  for (const b of bindings) {
    if (!b.organizationId) continue;
    const list = bindingMap.get(b.organizationId) || [];
    list.push({ repId: b.representativeId, status: b.status });
    bindingMap.set(b.organizationId, list);
  }

  const augmented = organizations.map((org) => {
    const { aliases: _aliases, ...rest } = org;
    void _aliases;
    const orgBindings = bindingMap.get(org.id) || [];
    let availability: Availability = "AVAILABLE";

    const ownActive = orgBindings.some((b) => b.repId === ownRepId && b.status === "ACTIVE");
    const ownPending = orgBindings.some((b) => b.repId === ownRepId && b.status === "PENDING");
    const otherActive = orgBindings.some((b) => b.repId !== ownRepId && b.status === "ACTIVE");
    const otherPending = orgBindings.some((b) => b.repId !== ownRepId && b.status === "PENDING");

    if (ownActive) availability = "OWN_ACTIVE";
    else if (ownPending) availability = "OWN_PENDING";
    else if (otherActive) availability = "OTHER_ACTIVE";
    else if (otherPending) availability = "OTHER_PENDING";

    return {
      ...rest,
      availability,
      availabilityLabel: AVAILABILITY_LABEL[availability],
    };
  });

  return NextResponse.json({ organizations: augmented });
}
