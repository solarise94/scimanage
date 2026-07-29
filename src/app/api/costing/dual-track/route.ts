import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { centsToYuan } from "@/lib/finance/money";
import { generateDualTrackReport } from "@/lib/costing/dual-track-report";

/**
 * GET /api/costing/dual-track?limit=10
 *
 * Phase 4 双轨核对报表。ADMIN only。
 * 返回 FinanceCost 与 CostEntry 的按订单差异。
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.min(500, Math.max(1, parseInt(limitParam, 10))) : undefined;

  const report = await generateDualTrackReport(limit);

  return NextResponse.json({
    ...report,
    totalDiff: centsToYuan(report.totalDiff),
    diffs: report.diffs.map((d) => ({
      ...d,
      financeCostSum: centsToYuan(d.financeCostSum),
      costEntryRealCost: centsToYuan(d.costEntryRealCost),
      diff: centsToYuan(d.diff),
    })),
  });
}
