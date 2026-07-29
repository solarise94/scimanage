import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isSupplyChainBlocked, assertOrderVisibleForSupplyChain } from "@/lib/supply-chain/permissions";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ mappingId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isSupplyChainBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { mappingId } = await params;

  const mapping = await prisma.orderLineServiceMapping.findUnique({
    where: { id: mappingId },
    select: { id: true, orderLine: { select: { orderId: true } } },
  });
  if (!mapping) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // 从 mapping 反查订单 → scope 校验
  const visible = await assertOrderVisibleForSupplyChain(
    session.user.id,
    session.user.role,
    mapping.orderLine.orderId,
    session.user.department,
  );
  if (!visible) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await prisma.orderLineServiceMapping.delete({ where: { id: mappingId } });
  return NextResponse.json({ ok: true });
}
