import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isOrderAccessBlocked, getOrderScopeWhere } from "@/lib/orders/permissions";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isOrderAccessBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  // Verify order exists and is in scope
  const order = await prisma.order.findUnique({ where: { id }, select: { id: true } });
  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (session.user.role !== "ADMIN") {
    const scopeWhere = await getOrderScopeWhere(session.user.id, session.user.role, prisma, session.user.department);
    if (scopeWhere) {
      const inScope = await prisma.order.count({ where: { id, AND: [scopeWhere] } });
      if (inScope === 0) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const history = await prisma.orderStatusHistory.findMany({
    where: { orderId: id },
    orderBy: { createdAt: "desc" },
    include: {
      createdBy: { select: { id: true, name: true } },
    },
  });

  return NextResponse.json({ history });
}
