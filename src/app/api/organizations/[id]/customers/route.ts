import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { buildLegacyCustomerFields, customerCrmProfileSelect } from "@/lib/customers/customer-business-fields";

async function assertAdmin(session: { user: { id: string; role: string } } | null) {
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (!user || user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return null;
}

/**
 * 机构维度客户列表（W6.9.4：只认 Profile；`id` = profileId）。
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  const forbidden = await assertAdmin(session);
  if (forbidden) return forbidden;

  const { id } = await params;

  const org = await prisma.organization.findUnique({ where: { id }, select: { id: true } });
  if (!org) return NextResponse.json({ error: "机构不存在" }, { status: 404 });

  const { searchParams } = new URL(req.url);
  const search = searchParams.get("search")?.trim() || "";
  const siteId = searchParams.get("siteId")?.trim() || "";
  const includeArchived = searchParams.get("includeArchived") === "true";
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get("pageSize") || "20", 10) || 20));

  const andConditions: Prisma.CrmCustomerProfileWhereInput[] = [
    { organizationId: id, deleted: false },
  ];
  if (siteId) andConditions.push({ organizationSiteId: siteId });
  if (!includeArchived) andConditions.push({ archived: false });
  if (search) {
    andConditions.push({
      OR: [
        { name: { contains: search } },
        { customerCode: { contains: search } },
      ],
    });
  }

  const where: Prisma.CrmCustomerProfileWhereInput = { AND: andConditions };

  const [rows, total] = await Promise.all([
    prisma.crmCustomerProfile.findMany({
      where,
      select: {
        ...customerCrmProfileSelect,
        stage: true,
        _count: { select: { profileProjects: true, profileOrders: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.crmCustomerProfile.count({ where }),
  ]);

  const customers = rows.map((profile) => {
    const biz = buildLegacyCustomerFields({ crmProfile: profile });
    return {
      id: profile.id,
      profileId: profile.id,
      name: biz.name,
      customerCode: biz.customerCode,
      organization: biz.organization,
      organizationId: biz.organizationId,
      organizationSiteId: biz.organizationSiteId,
      labOrGroup: biz.labOrGroup,
      principal: biz.principal,
      email: biz.email,
      wechat: biz.wechat,
      phone: biz.phone,
      orgSite: profile.orgSite ?? null,
      crmProfile: {
        id: profile.id,
        stage: profile.stage,
        archived: profile.archived,
      },
      _count: {
        projects: profile._count.profileProjects,
        orders: profile._count.profileOrders,
      },
    };
  });

  return NextResponse.json({ customers, total, page, pageSize });
}
