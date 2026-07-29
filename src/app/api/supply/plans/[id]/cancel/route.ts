import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canLockPlan, assertSupplyPlanVisible } from "@/lib/supply-chain/permissions";
import { cancelSupplyPlan } from "@/lib/supply-chain/cancel-plan";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canLockPlan(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id: planId } = await params;

  const plan = await prisma.supplyPlan.findUnique({
    where: { id: planId },
    select: { id: true },
  });
  if (!plan) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // 对象级 scope 校验：防止越权取消他人订单的方案
  const visible = await assertSupplyPlanVisible(
    session.user.id,
    session.user.role,
    planId,
    session.user.department,
  );
  if (!visible) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const reason = (body as Record<string, unknown>)?.reason as string | undefined;

  try {
    const result = await cancelSupplyPlan({
      planId,
      actorUserId: session.user.id,
      reason,
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof Error && e.message === "NOT_FOUND") {
      return NextResponse.json({ error: "方案不存在" }, { status: 404 });
    }
    if (e instanceof Error && e.message === "HAS_ACTIVE_PAYABLES") {
      const count = (e as Error & { count?: number }).count;
      return NextResponse.json(
        {
          error: `该方案已生成 ${count ?? ""} 笔有效应付（含未付款与已付款），不能直接取消。请先在财务侧取消/冲销应付；已有付款按财务冲销流程处理。`,
        },
        { status: 409 },
      );
    }
    throw e;
  }
}
