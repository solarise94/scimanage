import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isRepresentative, getRepresentativeProjectIds } from "@/lib/permissions";
import { isRegionalManagerRole, getEffectiveCrmVisibleProfileIds } from "@/lib/crm/permissions";
import { getCustomerOrganizationName } from "@/lib/customer-organization";
import { generateCustomerCode } from "@/lib/customer-code";
import { appendProfileRepresentativeInfo } from "@/lib/customers/customer-select-options";
import type { CustomerSelectOption } from "@/lib/customers/customer-select-options";
import { ensureOrganizationFromInput } from "@/lib/organizations/ensure-organization";
import { resolveCustomerOrganizationWrite } from "@/lib/customers/customer-organization-write";
import { createCrmCustomerProfile } from "@/lib/crm/create-profile";
import { resolveEffectiveRepresentativesForProfiles } from "@/lib/crm/customer-effective-representative";
import { CUSTOMER_API_AUDIT_TARGETS, logCustomerApiAudit, extractCustomerApiAuditContext } from "@/lib/customers/customer-api-audit";
import { findDuplicateCustomers } from "@/lib/crm/customer-application-review";

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
      { email: { contains: token } },
      { principal: { contains: token } },
      { wechat: { contains: token } },
      { nameAliases: { some: { alias: { contains: token }, active: true } } },
      { org: { canonicalName: { contains: token } } },
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

const PROFILE_LIST_SELECT = {
  id: true,
  name: true,
  customerCode: true,
  organization: true,
  organizationId: true,
  principal: true,
  wechat: true,
  address: true,
  archived: true,
  createdAt: true,
  org: { select: { canonicalName: true } },
  orgSite: { select: { siteName: true } },
  _count: { select: { profileProjects: true } },
} as const;

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
        where: { id: { in: projectIds }, profileId: { not: null } },
        select: { profileId: true },
      });
      for (const p of projects) {
        if (p.profileId) idSet.add(p.profileId);
      }
    }
  }

  return [...idSet];
}

/**
 * W6.9.4：GET 只认 Profile；响应 `id`/`profileId` 均为 CrmCustomerProfile.id。
 */
export async function GET(req: NextRequest) {
  const auditCtx = extractCustomerApiAuditContext(req);
  const session = await getServerSession(authOptions);
  if (!session) {
    await logCustomerApiAudit({
      path: "/api/customers",
      method: "GET",
      forwardedTo: CUSTOMER_API_AUDIT_TARGETS.PROFILE_COMPAT,
      statusCode: 401,
      callerTag: "customers-route",
      ...auditCtx,
    });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const search = searchParams.get("search") || "";
  const showArchived = searchParams.get("archived") === "true";
  const includeDeleted = searchParams.get("includeDeleted") === "true" && session.user.role === "ADMIN";
  const limitParam = searchParams.get("limit");
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get("pageSize") || "20", 10)));
  const searchWhere = search ? buildProfileSearchWhere(search) : null;

  const activeParts: Array<Record<string, unknown> | null> = [];
  if (!includeDeleted) activeParts.push({ deleted: false });
  if (!showArchived) activeParts.push({ archived: false });

  const isScoped =
    isRepresentative(session.user.role) || isRegionalManagerRole(session.user.role);

  let scopeWhere: Record<string, unknown> | null = null;
  if (isScoped) {
    const includeProjectLinked = isRepresentative(session.user.role);
    const profileIds = await getScopedVisibleProfileIds(
      session.user.id,
      session.user.role,
      includeProjectLinked,
    );
    if (profileIds.length === 0) {
      await logCustomerApiAudit({
        path: "/api/customers",
        method: "GET",
        callerUserId: session.user.id,
        forwardedTo: CUSTOMER_API_AUDIT_TARGETS.PROFILE_COMPAT,
        statusCode: 200,
        callerTag: "customers-route",
        ...auditCtx,
      });
      return NextResponse.json({
        customers: [],
        total: 0,
        page: limitParam ? 1 : page,
        pageSize: limitParam ? 0 : pageSize,
        totalPages: 1,
      });
    }
    scopeWhere = { id: { in: profileIds } };
  }

  const where = andWhere(scopeWhere, ...activeParts, searchWhere);
  const skip = limitParam ? 0 : (page - 1) * pageSize;
  const take = limitParam ? Math.min(parseInt(limitParam, 10) || 500, 500) : pageSize;

  const [profiles, total] = await Promise.all([
    prisma.crmCustomerProfile.findMany({
      where,
      select: PROFILE_LIST_SELECT,
      orderBy: [{ archived: "asc" }, { createdAt: "desc" }],
      skip,
      take,
    }),
    prisma.crmCustomerProfile.count({ where }),
  ]);

  const withOrg = profiles.map((p) => ({
    ...p,
    organization: getCustomerOrganizationName({
      organization: p.organization,
      org: p.org,
      orgSite: p.orgSite,
    }),
  }));
  const mapped = await appendProfileRepresentativeInfo(withOrg);
  const customers = mapped.map((p) => ({
    id: p.id,
    profileId: p.id,
    name: p.name,
    customerCode: p.customerCode,
    organization: p.organization,
    organizationId: p.organizationId,
    principal: p.principal,
    wechat: p.wechat,
    address: p.address,
    archived: p.archived,
    representativeId: p.representativeId,
    representativeName: p.representativeName,
    _count: { projects: p._count.profileProjects },
  }));

  await logCustomerApiAudit({
    path: "/api/customers",
    method: "GET",
    callerUserId: session.user.id,
    forwardedTo: CUSTOMER_API_AUDIT_TARGETS.PROFILE_COMPAT,
    statusCode: 200,
    callerTag: "customers-route",
    ...auditCtx,
  });
  return NextResponse.json({
    customers,
    total,
    page: limitParam ? 1 : page,
    pageSize: limitParam ? customers.length : pageSize,
    totalPages: limitParam ? 1 : Math.ceil(total / pageSize),
  });
}

export async function POST(req: NextRequest) {
  const auditCtx = extractCustomerApiAuditContext(req);
  const session = await getServerSession(authOptions);
  if (!session) {
    await logCustomerApiAudit({
      path: "/api/customers",
      method: "POST",
      forwardedTo: CUSTOMER_API_AUDIT_TARGETS.PROFILE_COMPAT,
      statusCode: 401,
      callerTag: "customers-route",
      ...auditCtx,
    });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (isRepresentative(session.user.role)) {
    await logCustomerApiAudit({
      path: "/api/customers",
      method: "POST",
      callerUserId: session.user.id,
      forwardedTo: CUSTOMER_API_AUDIT_TARGETS.PROFILE_COMPAT,
      statusCode: 403,
      callerTag: "customers-route",
      ...auditCtx,
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const {
      name, principal, email, wechat, organization, address, miniProgramId,
      organizationId, organizationSiteId, organizationRawInput, autoCreateOrganization,
    } = body;

    if (!name?.trim()) {
      return NextResponse.json({ error: "客户姓名为必填项" }, { status: 400 });
    }

    let resolvedOrgId: string | null = organizationId || null;

    if (!resolvedOrgId && autoCreateOrganization && organizationRawInput?.trim()) {
      try {
        const ensured = await ensureOrganizationFromInput(organizationRawInput.trim());
        resolvedOrgId = ensured.organizationId;
      } catch (e) {
        console.error("ensureOrganizationFromInput failed:", e);
        return NextResponse.json(
          { error: `单位创建失败：${e instanceof Error ? e.message : "未知错误"}` },
          { status: 400 },
        );
      }
    }

    const orgWrite = await resolveCustomerOrganizationWrite({
      organizationId: resolvedOrgId,
      organizationSiteId: organizationSiteId || null,
      organizationText: organization?.trim() || null,
      organizationRawInput: organizationRawInput?.trim() || null,
    });

    if (!orgWrite.ok) {
      return NextResponse.json({ error: orgWrite.message }, { status: orgWrite.status });
    }

    if (!orgWrite.organizationId) {
      return NextResponse.json(
        { error: "客户单位为必填项，请选择或填写机构后再创建" },
        { status: 400 },
      );
    }

    const finalOrganizationId = orgWrite.organizationId;
    const finalOrganizationName = orgWrite.organization;
    const effectiveSiteId = orgWrite.organizationSiteId;
    const finalOrganizationRawInput = orgWrite.organizationRawInput;

    const { blocking: dupBlocking } = await findDuplicateCustomers({
      name: name.trim(),
      email: email?.trim() || null,
      wechat: wechat?.trim() || null,
      miniProgramId: miniProgramId?.trim() || null,
      organizationId: finalOrganizationId,
      organizationRawInput: finalOrganizationRawInput,
      organization: finalOrganizationName,
      principal: principal?.trim() || null,
    });
    if (dupBlocking.length > 0) {
      await logCustomerApiAudit({
        path: "/api/customers",
        method: "POST",
        callerUserId: session.user.id,
        forwardedTo: CUSTOMER_API_AUDIT_TARGETS.PROFILE_COMPAT,
        statusCode: 409,
        callerTag: "customers-route",
        ...auditCtx,
      });
      return NextResponse.json({
        error: "检测到可能重复的客户，请先去客户档案库核对",
        code: "DUPLICATE_CANDIDATES",
        candidates: dupBlocking.map((c) => ({
          id: c.id,
          name: c.name,
          customerCodeLast6: c.customerCodeLast6,
          organization: c.organization,
          hasCrmProfile: c.hasCrmProfile,
          matchReasons: c.matchReasons,
          matchedName: c.matchedName,
          matchedNameType: c.matchedNameType,
        })),
      }, { status: 409 });
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const customerCode = await generateCustomerCode();
        const result = await prisma.$transaction(async (tx) => {
          const { id: profileId } = await createCrmCustomerProfile({
            name: name.trim(),
            customerCode,
            principal: principal?.trim() || null,
            email: email?.trim() || null,
            wechat: wechat?.trim() || null,
            organization: finalOrganizationName,
            organizationId: finalOrganizationId,
            organizationSiteId: effectiveSiteId,
            organizationRawInput: finalOrganizationRawInput,
            address: address?.trim() || null,
            miniProgramId: miniProgramId?.trim() || null,
            sourceHint: "MANUAL",
          }, tx);

          const full = await tx.crmCustomerProfile.findUniqueOrThrow({
            where: { id: profileId },
            select: {
              name: true,
              customerCode: true,
              organization: true,
              organizationId: true,
              organizationSiteId: true,
              principal: true,
              wechat: true,
              address: true,
              org: { select: { canonicalName: true } },
            },
          });

          return { profileId, ...full };
        });

        const effective = (
          await resolveEffectiveRepresentativesForProfiles([result.profileId])
        ).get(result.profileId);
        const option: CustomerSelectOption = {
          profileId: result.profileId,
          id: result.profileId,
          name: result.name ?? name.trim(),
          customerCode: result.customerCode ?? customerCode,
          principal: result.principal,
          wechat: result.wechat,
          address: result.address,
          organization: getCustomerOrganizationName({
            organization: result.organization,
            org: result.org,
          }),
          organizationId: result.organizationId,
          representativeId: effective?.representativeId ?? null,
          representativeName: effective?.representativeName ?? null,
        };

        await logCustomerApiAudit({
          path: "/api/customers",
          method: "POST",
          callerUserId: session.user.id,
          profileId: result.profileId,
          fieldsTouched: [
            "name", "principal", "email", "wechat", "organization",
            "address", "miniProgramId", "organizationId", "organizationSiteId", "organizationRawInput",
          ],
          forwardedTo: CUSTOMER_API_AUDIT_TARGETS.PROFILE_COMPAT,
          statusCode: 201,
          callerTag: "customers-route",
          ...auditCtx,
        });

        return NextResponse.json({ customer: option }, { status: 201 });
      } catch (e: unknown) {
        const isPrismaUnique =
          typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002";
        if (!isPrismaUnique || attempt === 2) throw e;
      }
    }

    return NextResponse.json({ error: "创建客户失败" }, { status: 500 });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "创建客户失败" }, { status: 500 });
  }
}
