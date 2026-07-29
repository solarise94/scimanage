import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { centsToYuan } from "@/lib/finance/money";
import { isRepresentative } from "@/lib/permissions";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isRepresentative(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const order = await prisma.externalOrder.findUnique({
    where: { id },
    include: {
      invoiceRequests: {
        include: {
          items: { orderBy: { sortOrder: "asc" } },
          createdBy: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
      },
      reviewedBy: { select: { id: true, name: true } },
      mergedInto: { select: { id: true, externalOrderNo: true, source: true } },
      profile: { select: { id: true, name: true, customerCode: true } },
    },
  });

  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let duplicateGroup: Array<{
    id: string; externalOrderNo: string; source: string; platform: string | null;
    receiverName: string | null; receiverPhone: string | null;
    paidAmount: number | null; orderAt: Date | null;
    productNamesRaw: string | null; duplicateStatus: string;
  }> = [];
  if (order.duplicateGroupId) {
    duplicateGroup = await prisma.externalOrder.findMany({
      where: { duplicateGroupId: order.duplicateGroupId, id: { not: order.id } },
      select: {
        id: true, externalOrderNo: true, source: true, platform: true,
        receiverName: true, receiverPhone: true,
        paidAmount: true, orderAt: true,
        productNamesRaw: true, duplicateStatus: true,
      },
    });
  }

  return NextResponse.json({
    order: {
      ...order,
      customer: order.profile ? {
        id: order.profile.id,
        name: order.profile.name ?? null,
        customerCode: order.profile.customerCode ?? null,
      } : null,
      paidAmount: order.paidAmount != null ? centsToYuan(order.paidAmount) : null,
      financeAmountOverride: order.financeAmountOverride != null ? centsToYuan(order.financeAmountOverride) : null,
    },
    duplicateGroup: duplicateGroup.map((d) => ({
      ...d,
      paidAmount: d.paidAmount != null ? centsToYuan(d.paidAmount) : null,
    })),
  });
}

export async function PATCH() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ error: "此接口已迁移至 /api/orders/[id]" }, { status: 410 });
}
