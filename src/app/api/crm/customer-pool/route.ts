import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isRegionalManagerRole } from "@/lib/crm/permissions";
import { deriveGraduationStatus, buildGraduationStatusWhere } from "@/lib/crm/profile-filters";
import { filterByPinyin } from "@/lib/crm/pinyin-search";
import { customerPoolProfileInclude as profileInclude } from "@/lib/crm/includes";
import { buildCrmProfileCustomerView } from "@/lib/customers/customer-business-fields";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isRegionalManagerRole(session.user.role) || session.user.role === "REPRESENTATIVE") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = req.nextUrl;
  const status = searchParams.get("assignmentStatus") || "";
  const search = searchParams.get("search") || "";
  const stage = searchParams.get("stage") || "";
  const organizationId = searchParams.get("organizationId") || "";
  const siteId = searchParams.get("siteId") || "";
  const personCategory = searchParams.get("personCategory") || "";
  const jobTitle = searchParams.get("jobTitle") || "";
  const graduationStatus = searchParams.get("graduationStatus") || "";
  const graduationDateFrom = searchParams.get("graduationDateFrom") || "";
  const graduationDateTo = searchParams.get("graduationDateTo") || "";
  const includeArchived = searchParams.get("archived") === "true";
  const includeDeleted = searchParams.get("includeDeleted") === "true";
  if (includeDeleted && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "仅管理员可查看已删除客户" }, { status: 403 });
  }
  const page = Math.max(1, parseInt(searchParams.get("page") || "1") || 1);
  const pageSize = Math.min(100, Math.max(10, parseInt(searchParams.get("pageSize") || "20") || 20));
  const sort = searchParams.get("sort") || "updatedAt";
  const order = searchParams.get("order") || "desc";

  const andConditions: Record<string, unknown>[] = [];
  if (!includeArchived) andConditions.push({ archived: false });
  if (!includeDeleted) andConditions.push({ deleted: false });
  if (status) {
    andConditions.push({ assignmentStatus: status });
  } else {
    andConditions.push({ assignmentStatus: { in: ["UNASSIGNED", "RECALLED"] } });
  }
  if (stage) andConditions.push({ stage });
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

  // Phase 2.1: 机构字段 sovereignty → Profile；筛选直接加在 Profile 上。
  if (organizationId) andConditions.push({ organizationId });
  if (siteId) andConditions.push({ organizationSiteId: siteId });

  // Phase 2.3: 身份字段搜索切到 Profile 本体
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

  const where: Record<string, unknown> =
    andConditions.length === 0
      ? {}
      : andConditions.length === 1
        ? andConditions[0]
        : { AND: andConditions };

  // Pinyin supplement uses Profile主权 name/customerCode only.
  const pinyinAndConditions: Record<string, unknown>[] = andConditions.filter(
    (c) => !("OR" in c),
  );
  const pinyinWhere: Record<string, unknown> =
    pinyinAndConditions.length === 0
      ? {}
      : pinyinAndConditions.length === 1
        ? pinyinAndConditions[0]
        : { AND: pinyinAndConditions };

  const validSorts = ["updatedAt", "createdAt", "lastFollowUpAt", "nextFollowUpAt", "stage"];
  const sortField = validSorts.includes(sort) ? sort : "updatedAt";
  const sortOrder = order === "asc" ? "asc" : "desc";

  const [profiles, total] = await Promise.all([
    prisma.crmCustomerProfile.findMany({
      where,
      include: profileInclude,
      orderBy: { [sortField]: sortOrder },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.crmCustomerProfile.count({ where }),
  ]);

  // Pinyin fallback — augment results if search is active
  if (search && profiles.length < pageSize) {
    const existingIds = new Set(profiles.map((p) => p.id));
    const pinyinPool = await prisma.crmCustomerProfile.findMany({
      where: pinyinWhere,
      include: profileInclude,
      orderBy: { [sortField]: sortOrder },
    });
    const pinyinMatches = filterByPinyin(
      pinyinPool.map((p) => ({ ...p, name: p.name || "", customerCode: p.customerCode || "" })),
      search,
      existingIds,
    );
    const remaining = pageSize - profiles.length;
    profiles.push(...pinyinMatches.slice(0, remaining) as typeof profiles);
  }

  const enriched = profiles.map((p) => ({
    ...p,
    graduationStatus: deriveGraduationStatus(p.personCategory, p.graduationDate),
    customerView: buildCrmProfileCustomerView(p),
  }));

  return NextResponse.json({ profiles: enriched, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
}
