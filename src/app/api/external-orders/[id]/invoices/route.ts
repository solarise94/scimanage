import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isRepresentative } from "@/lib/permissions";
import { centsToYuan } from "@/lib/finance/money";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isRepresentative(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id: externalOrderId } = await params;
  const order = await prisma.externalOrder.findUnique({ where: { id: externalOrderId }, select: { id: true } });
  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const coverageInvoiceIds = (
    await prisma.externalOrderInvoiceCoverage.findMany({
      where: { externalOrderId },
      select: { invoiceRequestId: true },
    })
  ).map((c) => c.invoiceRequestId);

  const directInvoices = await prisma.externalOrderInvoiceRequest.findMany({
    where: { externalOrderId },
    include: {
      items: { orderBy: { sortOrder: "asc" } },
      createdBy: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const coverageInvoices = coverageInvoiceIds.length > 0
    ? await prisma.externalOrderInvoiceRequest.findMany({
        where: { id: { in: coverageInvoiceIds } },
        include: {
          items: { orderBy: { sortOrder: "asc" } },
          createdBy: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
      })
    : [];

  const seen = new Set(directInvoices.map((i) => i.id));
  const merged = [...directInvoices];
  for (const inv of coverageInvoices) {
    if (!seen.has(inv.id)) {
      merged.push(inv);
      seen.add(inv.id);
    }
  }

  return NextResponse.json({
    invoices: merged.map((inv) => ({
      ...inv,
      totalAmount: centsToYuan(inv.totalAmount),
      items: inv.items.map((it) => ({ ...it, amount: it.amount != null ? centsToYuan(it.amount) : null })),
    })),
  });
}

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ error: "此接口已迁移至 /api/finance/order-invoices" }, { status: 410 });
}
