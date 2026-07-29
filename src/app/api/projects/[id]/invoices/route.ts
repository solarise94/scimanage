import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canReadProject } from "@/lib/permissions";
import { centsToYuan } from "@/lib/finance/money";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: projectId } = await params;
  const canRead = await canReadProject(projectId, session.user.id, session.user.role);
  if (!canRead) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const invoices = await prisma.projectInvoice.findMany({
    where: { projectId },
    include: {
      items: { orderBy: { sortOrder: "asc" } },
      createdBy: { select: { id: true, name: true } },
      sellerProfile: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({
    invoices: invoices.map((inv) => ({
      ...inv,
      totalAmount: centsToYuan(inv.totalAmount),
      items: inv.items.map((it) => ({ ...it, amount: it.amount != null ? centsToYuan(it.amount) : null })),
    })),
  });
}

export async function POST(_req: NextRequest, _params: { params: Promise<{ id: string }> }) {
  return NextResponse.json({ error: "项目开票已停用，请从订单详情页创建订单发票" }, { status: 410 });
}
