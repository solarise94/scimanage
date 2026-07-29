import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { centsToYuan } from "@/lib/finance/money";
import { canLockPlan, assertSupplyPlanVisible } from "@/lib/supply-chain/permissions";
import { lockSupplyPlan, SupplyPlanLockError } from "@/lib/supply-chain/commit-plan";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canLockPlan(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id: planId } = await params;

  // 校验方案存在
  const plan = await prisma.supplyPlan.findUnique({
    where: { id: planId },
    select: { id: true, orderId: true },
  });
  if (!plan) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // 对象级 scope 校验：通过方案 orderId 反查订单可见性，防止越权锁定他人订单方案
  const visible = await assertSupplyPlanVisible(
    session.user.id,
    session.user.role,
    planId,
    session.user.department,
  );
  if (!visible) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const result = await lockSupplyPlan({ planId, actorUserId: session.user.id });

    const updated = await prisma.supplyPlan.findUnique({
      where: { id: planId },
      select: { id: true, status: true, totalLockedCost: true, lockedAt: true },
    });

    return NextResponse.json({
      ...result,
      plan: updated
        ? {
            ...updated,
            totalLockedCost: updated.totalLockedCost != null ? centsToYuan(updated.totalLockedCost) : null,
          }
        : null,
    });
  } catch (e) {
    if (e instanceof SupplyPlanLockError) {
      const statusMap: Record<string, number> = {
        NOT_FOUND: 404,
        INVALID_STATUS: 400,
        INVALID_ORDER: 400,
        MISSING_PROFILE: 400,
        CONFLICT: 409,
        AMOUNT_MISMATCH: 400,
        EMPTY_PLAN: 400,
        // 预览→锁定之间资源状态变化：客户端应重新生成方案
        DEFINITION_HASH_MISMATCH: 409,
        QUOTE_INVALID: 409,
        SKU_INVALID: 409,
        MISSING_REQUIREMENT: 409,
      };
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: statusMap[e.code] ?? 400 },
      );
    }
    throw e;
  }
}
