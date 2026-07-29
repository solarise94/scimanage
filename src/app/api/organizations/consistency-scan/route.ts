import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { scanOrgTextDriftCandidates } from "@/lib/governance/org-text-mismatch-scan";
import {
  hasInvisibleUnicodeCharacters,
  listInvisibleUnicodeCodePoints,
} from "@/lib/organization-normalize";

async function assertAdmin(session: { user: { id: string; role: string } } | null) {
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (!user || user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return null;
}

const SAMPLE_LIMIT = 20;

// 需求 2 · 修复点 C：机构-客户一致性巡检（只读，供 admin 排查历史残留脏数据）
export async function GET() {
  const session = await getServerSession(authOptions);
  const forbidden = await assertAdmin(session);
  if (forbidden) return forbidden;

  // 1. 归档但仍挂客户的机构（修复点 A 之前的历史残留）
  const archivedOrgsWithCustomers = await prisma.organization.findMany({
    where: {
      archived: true,
      deleted: false,
      crmProfiles: { some: { deleted: false } },
    },
    select: {
      id: true,
      canonicalName: true,
      orgCode: true,
      _count: { select: { crmProfiles: { where: { deleted: false } } } },
    },
    orderBy: { canonicalName: "asc" },
  });
  const archivedOrgsWithCustomersView = archivedOrgsWithCustomers.map((o) => ({
    id: o.id,
    canonicalName: o.canonicalName,
    orgCode: o.orgCode,
    _count: { customers: o._count.crmProfiles },
  }));

  // 2. organizationId 指向已删除机构的客户（SQLite SetNull 应已清空，巡检确认）
  const customersPointingToDeletedOrgs = await prisma.crmCustomerProfile.findMany({
    where: {
      deleted: false,
      organizationId: { not: null },
      org: { deleted: true },
    },
    select: {
      id: true,
      name: true,
      customerCode: true,
      organizationId: true,
      organization: true,
    },
    orderBy: { name: "asc" },
  });

  // 3. organizationId 指向归档机构的客户
  const customersPointingToArchivedOrgs = await prisma.crmCustomerProfile.findMany({
    where: {
      deleted: false,
      organizationId: { not: null },
      org: { archived: true, deleted: false },
    },
    select: {
      id: true,
      name: true,
      customerCode: true,
      organizationId: true,
      organization: true,
      org: { select: { canonicalName: true, orgCode: true } },
    },
    orderBy: { name: "asc" },
  });

  // 4. 复用语义层扫描：空快照 / 文本漂移 / 无效 site
  const driftRecords = await scanOrgTextDriftCandidates(prisma);
  const missingSnapshot = driftRecords.filter(
    (r) => r.mismatchKind === "TEXT_DRIFT" && !(r.orgText || "").trim(),
  );
  const mismatchedSnapshot = driftRecords.filter(
    (r) => r.mismatchKind === "TEXT_DRIFT" && !!(r.orgText || "").trim(),
  );
  const invalidSite = driftRecords.filter((r) => r.mismatchKind === "INVALID_SITE");

  const toProfileSample = (r: (typeof driftRecords)[number]) => ({
    profileId: r.profileId,
    name: r.customerName,
    customerCode: r.customerCodeSnapshot,
    organizationId: r.organizationId,
    snapshotName: r.orgText || null,
    canonicalName: r.boundOrgName,
    organizationSiteId: r.organizationSiteId,
    mismatchKind: r.mismatchKind,
  });

  // 5. 不可见 Unicode 字符（只读诊断，码点以 U+XXXX 展示）
  const [orgs, aliases, sites] = await Promise.all([
    prisma.organization.findMany({
      where: { deleted: false },
      select: { id: true, orgCode: true, canonicalName: true },
    }),
    prisma.organizationAlias.findMany({
      select: { id: true, organizationId: true, alias: true },
    }),
    prisma.organizationSite.findMany({
      select: { id: true, organizationId: true, siteName: true, archived: true },
    }),
  ]);

  const organizationsWithInvisibleCharacters = orgs
    .filter((o) => hasInvisibleUnicodeCharacters(o.canonicalName))
    .map((o) => ({
      id: o.id,
      orgCode: o.orgCode,
      canonicalName: o.canonicalName,
      invisibleCodePoints: listInvisibleUnicodeCodePoints(o.canonicalName),
    }));

  const aliasesWithInvisibleCharacters = aliases
    .filter((a) => hasInvisibleUnicodeCharacters(a.alias))
    .map((a) => ({
      id: a.id,
      organizationId: a.organizationId,
      alias: a.alias,
      invisibleCodePoints: listInvisibleUnicodeCodePoints(a.alias),
    }));

  const sitesWithInvisibleCharacters = sites
    .filter((s) => hasInvisibleUnicodeCharacters(s.siteName))
    .map((s) => ({
      id: s.id,
      organizationId: s.organizationId,
      siteName: s.siteName,
      archived: s.archived,
      invisibleCodePoints: listInvisibleUnicodeCodePoints(s.siteName),
    }));

  return NextResponse.json({
    archivedOrgsWithCustomers: archivedOrgsWithCustomersView,
    customersPointingToDeletedOrgs,
    customersPointingToArchivedOrgs,
    profilesWithMissingOrganizationSnapshot: missingSnapshot.slice(0, SAMPLE_LIMIT).map(toProfileSample),
    profilesWithMismatchedOrganizationSnapshot: mismatchedSnapshot.slice(0, SAMPLE_LIMIT).map(toProfileSample),
    profilesWithInvalidSiteBinding: invalidSite.slice(0, SAMPLE_LIMIT).map(toProfileSample),
    organizationsWithInvisibleCharacters: organizationsWithInvisibleCharacters.slice(0, SAMPLE_LIMIT),
    aliasesWithInvisibleCharacters: aliasesWithInvisibleCharacters.slice(0, SAMPLE_LIMIT),
    sitesWithInvisibleCharacters: sitesWithInvisibleCharacters.slice(0, SAMPLE_LIMIT),
    counts: {
      archivedOrgsWithCustomers: archivedOrgsWithCustomersView.length,
      customersPointingToDeletedOrgs: customersPointingToDeletedOrgs.length,
      customersPointingToArchivedOrgs: customersPointingToArchivedOrgs.length,
      profilesWithMissingOrganizationSnapshot: missingSnapshot.length,
      profilesWithMismatchedOrganizationSnapshot: mismatchedSnapshot.length,
      profilesWithInvalidSiteBinding: invalidSite.length,
      organizationsWithInvisibleCharacters: organizationsWithInvisibleCharacters.length,
      aliasesWithInvisibleCharacters: aliasesWithInvisibleCharacters.length,
      sitesWithInvisibleCharacters: sitesWithInvisibleCharacters.length,
    },
  });
}
