import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isRepresentative, getRepresentativeProjectIds } from "@/lib/permissions";
import { isRegionalManagerRole, getEffectiveCrmVisibleProfileIds } from "@/lib/crm/permissions";
import { getCustomerOrganizationName } from "@/lib/customer-organization";
import { CUSTOMER_API_AUDIT_TARGETS, logCustomerApiAudit, extractCustomerApiAuditContext } from "@/lib/customers/customer-api-audit";
import { resolveEffectiveRepresentativesForProfiles } from "@/lib/crm/customer-effective-representative";

function tokenizeCustomerSearch(search: string) {
  return search
    .split(/[\s,，、;；]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function buildProfileSearchWhere(search: string): Record<string, unknown> {
  const tokens = tokenizeCustomerSearch(search);
  if (tokens.length === 0) return {};

  const tokenWhere = (token: string) => ({
    OR: [
      { name: { contains: token } },
      { customerCode: { contains: token } },
      { organization: { contains: token } },
      { principal: { contains: token } },
      { wechat: { contains: token } },
      { nameAliases: { some: { alias: { contains: token }, active: true } } },
    ],
  });

  return tokens.length === 1 ? tokenWhere(tokens[0]) : { AND: tokens.map(tokenWhere) };
}

function andWhere(...parts: Array<Record<string, unknown> | null | undefined>): Record<string, unknown> {
  const clauses = parts.filter((p): p is Record<string, unknown> => !!p && Object.keys(p).length > 0);
  if (clauses.length === 0) return {};
  if (clauses.length === 1) return clauses[0];
  return { AND: clauses };
}

async function makeResultFromProfiles(
  profiles: Array<{
    id: string;
    ownerUserId: string | null;
    name: string | null;
    customerCode: string | null;
    organization: string | null;
    organizationId: string | null;
    principal: string | null;
    wechat: string | null;
    address: string | null;
    assignmentStatus: string | null;
    org: { canonicalName: string } | null;
    orgSite: { siteName: string } | null;
    ownerUser: { email: string | null; role: string } | null;
  }>,
) {
  const effectiveMap =
    profiles.length > 0
      ? await resolveEffectiveRepresentativesForProfiles(profiles.map((p) => p.id))
      : new Map();

  return profiles.map((p) => {
    const eff = effectiveMap.get(p.id);
    return {
      profileId: p.id,
      /** 与 profileId 相同（选择器兼容 id 字段） */
      id: p.id,
      customerCode: p.customerCode ?? "------",
      name: p.name ?? "未命名客户",
      organization: getCustomerOrganizationName({
        organization: p.organization,
        org: p.org,
        orgSite: p.orgSite,
      }),
      organizationId: p.organizationId,
      principal: p.principal,
      wechat: p.wechat,
      address: p.address,
      representativeId: eff?.representativeId ?? null,
      representativeName: eff?.representativeName ?? null,
    };
  });
}

/**
 * Scoped 角色可见的 Profile ID 集合（W6.7b：只认 Profile 可见性）。
 * includeProjectLinked：代表非 crmScope 时并入项目关联 Profile。
 */
async function getScopedVisibleProfileIds(
  userId: string,
  role: string,
  includeProjectLinked: boolean,
): Promise<string[]> {
  const visible = await getEffectiveCrmVisibleProfileIds(userId, role);
  const idSet = new Set<string>(visible ? [...visible] : []);

  if (includeProjectLinked && isRepresentative(role)) {
    const projectIds = await getRepresentativeProjectIds(userId);
    if (projectIds.length > 0) {
      const projects = await prisma.project.findMany({
        where: {
          id: { in: projectIds },
          profileId: { not: null },
        },
        select: { profileId: true },
      });
      for (const p of projects) {
        if (p.profileId) idSet.add(p.profileId);
      }
    }
  }

  return [...idSet];
}

async function auditOk(
  sessionUserId: string,
  auditCtx: ReturnType<typeof extractCustomerApiAuditContext>,
) {
  await logCustomerApiAudit({
    path: "/api/customers/list",
    method: "GET",
    callerUserId: sessionUserId,
    forwardedTo: CUSTOMER_API_AUDIT_TARGETS.PROFILE_COMPAT,
    statusCode: 200,
    callerTag: "list-route",
    ...auditCtx,
  });
}

const PROFILE_SELECT = {
  id: true,
  ownerUserId: true,
  name: true,
  customerCode: true,
  organization: true,
  organizationId: true,
  principal: true,
  wechat: true,
  address: true,
  assignmentStatus: true,
  org: { select: { canonicalName: true } },
  orgSite: { select: { siteName: true } },
  ownerUser: { select: { email: true, role: true } },
} as const;

export async function GET(req: NextRequest) {
  const auditCtx = extractCustomerApiAuditContext(req);
  const session = await getServerSession(authOptions);
  if (!session) {
    await logCustomerApiAudit({
      path: "/api/customers/list",
      method: "GET",
      forwardedTo: CUSTOMER_API_AUDIT_TARGETS.PROFILE_COMPAT,
      statusCode: 401,
      callerTag: "list-route",
      ...auditCtx,
    });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const crmScope = req.nextUrl.searchParams.get("crmScope") === "true";
  const search = req.nextUrl.searchParams.get("search")?.trim() || "";
  const limit = Math.min(100, Math.max(1, parseInt(req.nextUrl.searchParams.get("limit") || "100", 10) || 100));

  const activeWhere = {
    deleted: false,
    archived: false,
  };
  const searchWhere = search ? buildProfileSearchWhere(search) : null;

  const isScoped = isRepresentative(session.user.role) || isRegionalManagerRole(session.user.role);

  if (isScoped) {
    const includeProjectLinked = isRepresentative(session.user.role) && !crmScope;
    const profileIds = await getScopedVisibleProfileIds(
      session.user.id,
      session.user.role,
      includeProjectLinked,
    );
    if (profileIds.length === 0) {
      await auditOk(session.user.id, auditCtx);
      return NextResponse.json({ customers: [] });
    }
    const profiles = await prisma.crmCustomerProfile.findMany({
      where: andWhere({ id: { in: profileIds } }, activeWhere, searchWhere),
      select: PROFILE_SELECT,
      orderBy: { name: "asc" },
      take: limit,
    });
    const resolved = await makeResultFromProfiles(profiles);
    await auditOk(session.user.id, auditCtx);
    return NextResponse.json({ customers: resolved });
  }

  const profiles = await prisma.crmCustomerProfile.findMany({
    where: andWhere(activeWhere, searchWhere),
    select: PROFILE_SELECT,
    orderBy: { name: "asc" },
    take: limit,
  });

  const resolved = await makeResultFromProfiles(profiles);
  await auditOk(session.user.id, auditCtx);
  return NextResponse.json({ customers: resolved });
}
