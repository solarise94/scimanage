import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { normalizeOrderFinanceTreatment } from "@/lib/orders/constants";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.orderIds)) {
    return NextResponse.json({ error: "orderIds 必须是数组" }, { status: 400 });
  }

  const orderIds = [...new Set((body.orderIds as unknown[]).map((id) => String(id).trim()).filter(Boolean))];
  if (orderIds.length === 0) {
    return NextResponse.json({ error: "orderIds 不能为空" }, { status: 400 });
  }

  const rawTreatment = typeof body.financeTreatment === "string" ? body.financeTreatment : undefined;
  if (!rawTreatment || !["AUTO", "STANDALONE", "PROJECT_INCLUDED", "EXCLUDED"].includes(rawTreatment)) {
    return NextResponse.json({ error: "financeTreatment 必须是 AUTO、STANDALONE、PROJECT_INCLUDED 或 EXCLUDED" }, { status: 400 });
  }
  const financeTreatment = normalizeOrderFinanceTreatment(rawTreatment);

  const result = await prisma.order.updateMany({
    where: { id: { in: orderIds }, deleted: false },
    data: { financeTreatment },
  });

  return NextResponse.json({
    updatedCount: result.count,
    financeTreatment,
  });
}
