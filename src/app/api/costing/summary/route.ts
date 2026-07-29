import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { centsToYuan } from "@/lib/finance/money";
import { isCostingBlocked, assertSubjectScopeReadable } from "@/lib/costing/permissions";
import { COST_BASIS, isValidCostBasis } from "@/lib/costing/constants";
import { getCostSummary } from "@/lib/costing/summary";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isCostingBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const subjectType = url.searchParams.get("subjectType")?.trim().toUpperCase() || "";
  const subjectId = url.searchParams.get("subjectId")?.trim() || "";
  const basis = (url.searchParams.get("basis")?.trim().toUpperCase() || COST_BASIS.FULL) as string;
  const forceRefresh = url.searchParams.get("refresh") === "true";

  if (!["ORDER", "PROJECT", "CUSTOMER"].includes(subjectType)) {
    return NextResponse.json({ error: "subjectType 必须为 ORDER / PROJECT / CUSTOMER" }, { status: 400 });
  }
  if (!subjectId) return NextResponse.json({ error: "subjectId 必填" }, { status: 400 });
  if (!isValidCostBasis(basis)) {
    return NextResponse.json({ error: `无效口径：${basis}` }, { status: 400 });
  }

  // 对象级 scope 校验：防止越权枚举 ID 读取成本摘要
  const readable = await assertSubjectScopeReadable({
    userId: session.user.id,
    role: session.user.role,
    department: session.user.department,
    subjectType: subjectType as "ORDER" | "PROJECT" | "CUSTOMER",
    subjectId,
  });
  if (!readable) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const summary = await getCostSummary(
    { subjectType: subjectType as never, subjectId, basis: basis as never },
    { forceRefresh },
  );

  return NextResponse.json({
    summary: {
      ...summary,
      realCost: centsToYuan(summary.realCost),
      circulationCost: centsToYuan(summary.circulationCost),
      taxCost: centsToYuan(summary.taxCost),
      totalCost: centsToYuan(summary.totalCost),
      estimatedCost: centsToYuan(summary.estimatedCost),
      quotedCost: centsToYuan(summary.quotedCost),
      committedCost: centsToYuan(summary.committedCost),
      actualCost: centsToYuan(summary.actualCost),
      settledCost: centsToYuan(summary.settledCost),
    },
  });
}
