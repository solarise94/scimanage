import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { OrderCategory, OrderCategoryValidationError, assertValidOrderCategory } from "@/lib/orders/constants";

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

  let category: OrderCategory;
  try {
    const candidate = typeof body.category === "string" ? body.category : undefined;
    assertValidOrderCategory(candidate);
    category = candidate;
  } catch (e) {
    if (e instanceof OrderCategoryValidationError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }

  const result = await prisma.order.updateMany({
    where: { id: { in: orderIds }, deleted: false },
    data: { category },
  });

  return NextResponse.json({
    updatedCount: result.count,
    category,
  });
}
