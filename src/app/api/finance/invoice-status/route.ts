import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { isFinanceBlocked, getFinanceProjectScopeWhere } from "@/lib/finance/permissions";
import { computeProjectReceivable } from "@/lib/finance/types";
import { prisma } from "@/lib/prisma";
import { centsToYuan, roundForDisplay } from "@/lib/finance/money";

export async function GET(req: NextRequest) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (isFinanceBlocked(session.user.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = req.nextUrl;
  const type = url.searchParams.get("type") || "issued_unpaid";
  const search = url.searchParams.get("search")?.trim() || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));

  // Phase 0 review #5：财务聚合排除治理桶。
  const projectWhere: Record<string, unknown> = { deleted: false, systemType: "NORMAL" };
  if (session.user.role !== "ADMIN") {
    const projScope = await getFinanceProjectScopeWhere(session.user.id, session.user.role);
    if (projScope) projectWhere.id = projScope.id;
  }
  if (search) {
    projectWhere.OR = [
      { name: { contains: search } },
      { profile: { name: { contains: search } } },
    ];
  }

  const allProjects = await prisma.project.findMany({
    where: projectWhere,
    select: {
      id: true, name: true, budgetAmount: true, projectType: true, status: true, progress: true,
      profile: { select: { id: true, name: true } },
      invoices: {
        where: { status: { not: "CANCELLED" } },
        select: { id: true, totalAmount: true, status: true, createdAt: true },
      },
      receipts: { where: { deleted: false }, select: { id: true, amount: true, projectInvoiceId: true } },
    },
  });

  const items: Array<Record<string, unknown>> = [];

  for (const proj of allProjects) {
    const invoicedAmount = proj.invoices.reduce((s, i) => s + i.totalAmount, 0);
    const issuedInvoices = proj.invoices.filter((i) => i.status === "ISSUED");
    const receivable = computeProjectReceivable(proj);

    if (type === "issued_unpaid") {
      // Find invoices where received amount < invoice amount
      for (const inv of issuedInvoices) {
        const invReceived = proj.receipts
          .filter((r) => r.projectInvoiceId === inv.id)
          .reduce((s, r) => s + r.amount, 0);
        if (invReceived < inv.totalAmount) {
          items.push({
            type: "issued_unpaid",
            projectId: proj.id, projectName: proj.name,
            profileId: proj.profile?.id ?? null, customerName: proj.profile?.name || "",
            invoiceId: inv.id, invoiceAmount: roundForDisplay(centsToYuan(inv.totalAmount)),
            receivedAmount: roundForDisplay(centsToYuan(invReceived)), unpaidAmount: roundForDisplay(centsToYuan(inv.totalAmount - invReceived)),
            invoiceDate: inv.createdAt.toISOString(),
            invoiceStatus: inv.status,
          });
        }
      }
    } else {
      // uninvoiced: receivable > invoiced
      if (receivable > invoicedAmount) {
        items.push({
          type: "uninvoiced",
          projectId: proj.id, projectName: proj.name,
          profileId: proj.profile?.id ?? null, customerName: proj.profile?.name || "",
          receivableAmount: roundForDisplay(centsToYuan(receivable)), invoicedAmount: roundForDisplay(centsToYuan(invoicedAmount)),
          uninvoicedAmount: roundForDisplay(centsToYuan(receivable - invoicedAmount)),
          progress: proj.progress, status: proj.status,
        });
      }
    }
  }

  const total = items.length;
  const paged = items.slice((page - 1) * pageSize, page * pageSize);

  return NextResponse.json({
    items: paged, total, page, pageSize, totalPages: Math.ceil(total / pageSize),
  });
}
