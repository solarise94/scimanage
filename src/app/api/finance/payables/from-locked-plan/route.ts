import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { prisma } from "@/lib/prisma";
import { createPayablesFromLockedPlan } from "@/lib/finance/supplier-payables";
import { PAYABLE_GRANULARITY } from "@/lib/finance/supplier-finance-constants";

export async function POST(req: NextRequest) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { planId, granularity } = body as Record<string, unknown>;

  if (!planId) return NextResponse.json({ error: "planId 必填" }, { status: 400 });

  const plan = await prisma.supplyPlan.findUnique({
    where: { id: planId as string },
    select: { id: true, status: true },
  });
  if (!plan) return NextResponse.json({ error: "方案不存在" }, { status: 404 });

  try {
    const result = await createPayablesFromLockedPlan({
      planId: planId as string,
      actorUserId: session.user.id,
      // 默认 COST_ENTRY 粒度（每个成本项一笔应付，可追溯）；
      // 仅显式传入 SUPPLIER_ORDER_PLAN 时才聚合。
      granularity: granularity === "SUPPLIER_ORDER_PLAN"
        ? PAYABLE_GRANULARITY.SUPPLIER_ORDER_PLAN
        : PAYABLE_GRANULARITY.COST_ENTRY,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "生成应付失败";
    // 设计 §7.3：跨部门成本项→订单拒绝生成应付，返回 409
    const status = message === "NOT_FOUND"
      ? 404
      : message.includes("跨部门应付")
        ? 409
        : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
