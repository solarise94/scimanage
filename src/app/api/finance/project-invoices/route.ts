import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { prisma } from "@/lib/prisma";
import { isFinanceBlocked, getFinanceProjectScopeWhere } from "@/lib/finance/permissions";
import { centsToYuan } from "@/lib/finance/money";

export async function GET(req: NextRequest) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (isFinanceBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const search = url.searchParams.get("search") || "";
  const status = url.searchParams.get("status") || "";
  const projectId = url.searchParams.get("projectId") || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10) || 20));

  const projectScope = await getFinanceProjectScopeWhere(session.user.id, session.user.role);

  const where: Record<string, unknown> = {};
  if (projectScope) {
    if (projectId) {
      if (!projectScope.id.in.includes(projectId)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      where.projectId = projectId;
    } else {
      where.projectId = projectScope.id;
    }
  } else if (projectId) {
    where.projectId = projectId;
  }
  if (status) where.status = status;

  const searchWhere = search ? {
    OR: [
      { buyerOrganizationName: { contains: search } },
      { project: { name: { contains: search } } },
      { project: { profile: { name: { contains: search } } } },
      { contactName: { contains: search } },
    ],
  } : {};

  const finalWhere = { ...where, ...searchWhere };

  const [invoices, total] = await Promise.all([
    prisma.projectInvoice.findMany({
      where: finalWhere,
      include: {
        items: { orderBy: { sortOrder: "asc" } },
        createdBy: { select: { id: true, name: true } },
        project: {
          select: { id: true, name: true, profile: { select: { id: true, name: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.projectInvoice.count({ where: finalWhere }),
  ]);

  return NextResponse.json({
    invoices: invoices.map((inv) => ({
      ...inv,
      project: inv.project ? {
        ...inv.project,
        cust: inv.project.profile ? { id: inv.project.profile.id, name: inv.project.profile.name ?? null } : null,
      } : null,
      totalAmount: centsToYuan(inv.totalAmount),
      items: inv.items.map((it) => ({ ...it, amount: it.amount != null ? centsToYuan(it.amount) : null })),
    })),
    total, page, pageSize, totalPages: Math.ceil(total / pageSize),
  });
}
