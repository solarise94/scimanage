import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { centsToYuan } from "@/lib/finance/money";
import { isCostingBlocked, assertSubjectScopeReadable } from "@/lib/costing/permissions";
import { COST_BASIS, isValidCostBasis } from "@/lib/costing/constants";
import { getOrderMargin } from "@/lib/costing/summary";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isCostingBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const orderId = url.searchParams.get("orderId")?.trim() || "";
  const basis = (url.searchParams.get("basis")?.trim().toUpperCase() || COST_BASIS.FULL) as string;

  if (!orderId) return NextResponse.json({ error: "orderId 必填" }, { status: 400 });
  if (!isValidCostBasis(basis)) {
    return NextResponse.json({ error: `无效口径：${basis}` }, { status: 400 });
  }

  // 对象级 scope 校验：防止越权枚举订单 ID 读取成本与毛利
  const readable = await assertSubjectScopeReadable({
    userId: session.user.id,
    role: session.user.role,
    department: session.user.department,
    subjectType: "ORDER",
    subjectId: orderId,
  });
  if (!readable) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const margin = await getOrderMargin(orderId, basis as never);

  return NextResponse.json({
    orderId,
    basis,
    revenue: centsToYuan(margin.revenue),
    supplyChainGrossMargin: centsToYuan(margin.supplyChainGrossMargin),
    operatingGrossMargin: centsToYuan(margin.operatingGrossMargin),
    netContribution: centsToYuan(margin.netContribution),
    netContributionRate: margin.netContributionRate,
    costSummary: {
      ...margin.costSummary,
      realCost: centsToYuan(margin.costSummary.realCost),
      circulationCost: centsToYuan(margin.costSummary.circulationCost),
      taxCost: centsToYuan(margin.costSummary.taxCost),
      totalCost: centsToYuan(margin.costSummary.totalCost),
    },
  });
}
